/*
 * Copyright (C) 2023 Amazon.com, Inc. or its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as node from 'aws-cdk-lib/aws-lambda-nodejs';

import { Construct } from 'constructs';
import { ServiceDescription } from '@project-lakechain/core/service';
import { ComputeType } from '@project-lakechain/core/compute-type';
import { when } from '@project-lakechain/core/dsl/vocabulary/conditions';
import { CacheStorage } from '@project-lakechain/core';
import { TitanImageGeneratorProps, TitanImageGeneratorPropsSchema } from './definitions/opts.js';
import { TitanImageModel } from './definitions/image-model.js';

import {
  TextToImageTask,
  ImageInpaintingTask,
  ImageOutpaintingTask,
  ImageVariationTask
} from './definitions/tasks';
import {
  Middleware,
  MiddlewareBuilder,
  LAMBDA_INSIGHTS_VERSION,
  NAMESPACE
} from '@project-lakechain/core/middleware';

/**
 * The service description.
 */
const description: ServiceDescription = {
  name: 'titan-image-generator',
  description: 'Generates images with Generative AI using Amazon Titan models on Amazon Bedrock.',
  version: '0.7.0',
  attrs: {}
};

/**
 * The maximum time the processing lambda
 * is allowed to run.
 */
const PROCESSING_TIMEOUT = cdk.Duration.minutes(2);

/**
 * The execution runtime for used compute.
 */
const EXECUTION_RUNTIME  = lambda.Runtime.NODEJS_18_X;

/**
 * The default memory size to allocate for the compute.
 */
const DEFAULT_MEMORY_SIZE = 256;

/**
 * The builder for the `TitanImageGenerator` service.
 */
class TitanImageGeneratorBuilder extends MiddlewareBuilder {
  private middlewareProps: Partial<TitanImageGeneratorProps> = {};

  /**
   * Sets the Titan image model to use for generating images.
   * @param model the Titan image model to use.
   * @returns the current builder instance.
   */
  public withImageModel(model: TitanImageModel) {
    this.middlewareProps.imageModel = model;
    return (this);
  }

  /**
   * Sets the parameters to execute by the image model.
   * @param task the task to execute by the image model.
   * @returns the current builder instance.
   */
  public withTask(task: TextToImageTask
    | ImageInpaintingTask
    | ImageOutpaintingTask
    | ImageVariationTask) {
    this.middlewareProps.task = task;
    return (this);
  }

  /**
   * Sets the AWS region in which the model
   * will be invoked.
   * @param region the AWS region in which the model
   * will be invoked.
   * @returns the current builder instance.
   */
  public withRegion(region: string) {
    this.middlewareProps.region = region;
    return (this);
  }

  /**
   * @returns a new instance of the `TitanImageGenerator`
   * service constructed with the given parameters.
   */
  public build(): TitanImageGenerator {
    return (new TitanImageGenerator(
      this.scope,
      this.identifier, {
        ...this.middlewareProps as TitanImageGeneratorProps,
        ...this.props
      }
    ));
  }
}

/**
 * A service providing image generation using Amazon Titan
 * models on Amazon Bedrock.
 */
export class TitanImageGenerator extends Middleware {

  /**
   * The storage containing processed files.
   */
  public storage: CacheStorage;

  /**
   * The data processor lambda function.
   */
  public eventProcessor: lambda.IFunction;

  /**
   * The builder for the `TitanImageGenerator` service.
   */
  static Builder = TitanImageGeneratorBuilder;

  /**
   * Construct constructor.
   */
  constructor(scope: Construct, id: string, private props: TitanImageGeneratorProps) {
    super(scope, id, description, {
      ...props,
      queueVisibilityTimeout: cdk.Duration.seconds(
        2 * PROCESSING_TIMEOUT.toSeconds()
      )
    });

    // Validate the properties.
    this.props = this.parse(TitanImageGeneratorPropsSchema, props);

    ///////////////////////////////////////////
    ////////    Processing Storage      ///////
    ///////////////////////////////////////////

    this.storage = new CacheStorage(this, 'Storage', {
      encryptionKey: this.props.kmsKey
    });

    ///////////////////////////////////////////
    //////    Middleware Event Handler     ////
    ///////////////////////////////////////////

    this.eventProcessor = new node.NodejsFunction(this, 'Compute', {
      description: 'Generates images using Amazon Titan models on Amazon Bedrock.',
      entry: path.resolve(__dirname, 'lambdas', 'handler', 'index.js'),
      vpc: this.props.vpc,
      memorySize: this.props.maxMemorySize ?? DEFAULT_MEMORY_SIZE,
      timeout: PROCESSING_TIMEOUT,
      runtime: EXECUTION_RUNTIME,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      environmentEncryption: this.props.kmsKey,
      logGroup: this.logGroup,
      insightsVersion: this.props.cloudWatchInsights ?
        LAMBDA_INSIGHTS_VERSION :
        undefined,
      environment: {
        POWERTOOLS_SERVICE_NAME: description.name,
        POWERTOOLS_METRICS_NAMESPACE: NAMESPACE,
        SNS_TARGET_TOPIC: this.eventBus.topicArn,
        PROCESSED_FILES_BUCKET: this.storage.id(),
        IMAGE_MODEL: this.props.imageModel.name,
        BEDROCK_REGION: this.props.region ?? '',
        TASK: JSON.stringify(this.props.task)
      },
      bundling: {
        minify: true,
        externalModules: [
          '@aws-sdk/client-s3',
          '@aws-sdk/client-sns'
        ]
      }
    });

    // Allows this construct to act as a `IGrantable`
    // for other middlewares to grant the processing
    // lambda permissions to access their resources.
    this.grantPrincipal = this.eventProcessor.grantPrincipal;

    // Plug the SQS queue into the lambda function.
    this.eventProcessor.addEventSource(new sources.SqsEventSource(this.eventQueue, {
      batchSize: this.props.batchSize ?? 1,
      maxConcurrency: 2,
      reportBatchItemFailures: true
    }));

    // Allow access to the Bedrock API.
    this.eventProcessor.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel'
      ],
      resources: [
        `arn:${cdk.Aws.PARTITION}:bedrock:${this.props.region ?? cdk.Aws.REGION}::foundation-model/${this.props.imageModel.name}`,
      ]
    }));

    // Grant the compute type permissions to
    // write to the post-processing bucket.
    this.storage.grantWrite(this.grantPrincipal);

    // Grant the compute type permissions to
    // publish to the SNS topic.
    this.eventBus.grantPublish(this.grantPrincipal);

    super.bind();
  }

  /**
   * Allows a grantee to read from the processed documents
   * generated by this middleware.
   */
  grantReadProcessedDocuments(grantee: iam.IGrantable): iam.Grant {
    return (this.storage.grantRead(grantee));
  }

  /**
   * @returns an array of mime-types supported as input
   * type by this middleware.
   */
  supportedInputTypes(): string[] {
    return ([
      'text/plain',
      'image/png',
      'image/jpeg',
      'application/json+scheduler'
    ]);
  }

  /**
   * @returns an array of mime-types supported as output
   * type by the data producer.
   */
  supportedOutputTypes(): string[] {
    return ([
      'image/png'
    ]);
  }

  /**
   * @returns the supported compute types by a given
   * middleware.
   */
  supportedComputeTypes(): ComputeType[] {
    return ([
      ComputeType.CPU
    ]);
  }

  /**
   * @returns the middleware conditional statement defining
   * in which conditions this middleware should be executed.
   * In this case, we want the middleware to only be invoked
   * when the document mime-type is supported, and the event
   * type is `document-created`.
   */
  conditional() {
    return (super
      .conditional()
      .and(when('type').equals('document-created'))
    );
  }
}

export { TitanImageModel } from './definitions/image-model';
export { TextToImageTask, ImageInpaintingTask, ImageOutpaintingTask } from './definitions/tasks';
export { ImageGenerationParameters } from './definitions/image-generation-props';
