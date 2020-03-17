/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as tfconv from '@tensorflow/tfjs-converter';
import * as tf from '@tensorflow/tfjs-core';

import {Box, scaleBoxCoordinates} from './box';

type HandDetectorPrediction = {
  boxes: tf.Tensor2D,
  palmLandmarks: tf.Tensor2D
};

export class HandDetector {
  private model: tfconv.GraphModel;
  private width: number;
  private height: number;
  private iouThreshold: number;
  private scoreThreshold: number;

  private anchors: Array<[number, number]>;
  private anchorsTensor: tf.Tensor2D;
  private inputSizeTensor: tf.Tensor1D;
  private doubleInputSizeTensor: tf.Tensor1D;

  constructor(
      model: tfconv.GraphModel, width: number, height: number,
      anchors: Array<{x_center: number, y_center: number}>,
      iouThreshold: number, scoreThreshold: number) {
    this.model = model;
    this.width = width;
    this.height = height;
    this.iouThreshold = iouThreshold;
    this.scoreThreshold = scoreThreshold;

    this.anchors = anchors.map(
        anchor => ([anchor.x_center, anchor.y_center] as [number, number]));
    this.anchorsTensor = tf.tensor2d(this.anchors);
    this.inputSizeTensor = tf.tensor1d([width, height]);
    this.doubleInputSizeTensor = tf.tensor1d([width * 2, height * 2]);
  }

  private normalizeBoxes(boxes: tf.Tensor2D): tf.Tensor2D {
    return tf.tidy(() => {
      const boxOffsets = tf.slice(boxes, [0, 0], [-1, 2]);
      const boxSizes = tf.slice(boxes, [0, 2], [-1, 2]);

      const boxCenterPoints =
          tf.add(tf.div(boxOffsets, this.inputSizeTensor), this.anchorsTensor);
      const halfBoxSizes = tf.div(boxSizes, this.doubleInputSizeTensor);

      const startPoints: tf.Tensor2D =
          tf.mul(tf.sub(boxCenterPoints, halfBoxSizes), this.inputSizeTensor);
      const endPoints: tf.Tensor2D =
          tf.mul(tf.add(boxCenterPoints, halfBoxSizes), this.inputSizeTensor);
      return tf.concat2d([startPoints, endPoints], 1);
    });
  }

  private normalizeLandmarks(rawPalmLandmarks: tf.Tensor2D, index: number):
      tf.Tensor2D {
    return tf.tidy(() => {
      const landmarks = tf.add(
          tf.div(rawPalmLandmarks.reshape([-1, 7, 2]), this.inputSizeTensor),
          this.anchors[index]);

      return tf.mul(landmarks, this.inputSizeTensor);
    });
  }

  private async getBoundingBoxes(input: tf.Tensor4D):
      Promise<HandDetectorPrediction> {
    // return tf.tidy(() => {
    // return {
    const normalizedInput = tf.mul(tf.sub(input, 0.5), 2);

    // Currently tfjs-core does not pack depthwiseConv because it fails for
    // very large inputs (https://github.com/tensorflow/tfjs/issues/1652).
    // TODO(annxingyuan): call tf.enablePackedDepthwiseConv when available
    // (https://github.com/tensorflow/tfjs/issues/2821)
    const savedWebglPackDepthwiseConvFlag =
        tf.env().get('WEBGL_PACK_DEPTHWISECONV');
    tf.env().set('WEBGL_PACK_DEPTHWISECONV', true);
    // The model returns a tensor with the following shape:
    //  [1 (batch), 2944 (anchor points), 19 (data for each anchor)]
    // Squeezing immediately because we are not batching inputs.
    const prediction: tf.Tensor2D =
        (this.model.predict(normalizedInput) as tf.Tensor3D).squeeze();
    await Promise.all([prediction.data()]);
    tf.env().set('WEBGL_PACK_DEPTHWISECONV', savedWebglPackDepthwiseConvFlag);

    // Regression score for each anchor point.
    const scores: tf.Tensor1D =
        tf.sigmoid(tf.slice(prediction, [0, 0], [-1, 1])).squeeze();

    // Bounding box for each anchor point.
    const rawBoxes = tf.slice(prediction, [0, 1], [-1, 4]);
    const boxes = this.normalizeBoxes(rawBoxes);

    await Promise.all([boxes.data()]);
    await Promise.all([scores.data()]);
    const savedConsoleWarnFn = console.warn;
    console.warn = () => {};
    const boxesWithHands =
        tf.image
            .nonMaxSuppression(
                boxes, scores, 1, this.iouThreshold, this.scoreThreshold)
            .arraySync();
    console.warn = savedConsoleWarnFn;

    if (boxesWithHands.length === 0) {
      return null;
    }

    const boxIndex = boxesWithHands[0];
    const matchingBox = tf.slice(boxes, [boxIndex, 0], [1, -1]);

    const rawPalmLandmarks = tf.slice(prediction, [boxIndex, 5], [1, 14]);
    const palmLandmarks: tf.Tensor2D =
        this.normalizeLandmarks(rawPalmLandmarks, boxIndex).reshape([-1, 2]);

    return {boxes: matchingBox, palmLandmarks};
    //});
  }

  /**
   * Returns a Box identifying the bounding box of a hand within the image.
   * Returns null if there is no hand in the image.
   *
   * @param input The image to classify.
   */
  async estimateHandBounds(input: tf.Tensor4D): Promise<Box> {
    const inputHeight = input.shape[1];
    const inputWidth = input.shape[2];

    const image: tf.Tensor4D =
        tf.tidy(() => input.resizeBilinear([this.width, this.height]).div(255));
    const prediction = await this.getBoundingBoxes(image);

    if (prediction === null) {
      image.dispose();
      return null;
    }

    await Promise.all([prediction.boxes.data()]);
    // Calling arraySync on both boxes and palmLandmarks because the tensors are
    // very small so it's not worth calling await array().
    const boundingBoxes =
        prediction.boxes.arraySync() as Array<[number, number, number, number]>;
    const startPoint = boundingBoxes[0].slice(0, 2) as [number, number];
    const endPoint = boundingBoxes[0].slice(2, 4) as [number, number];

    await Promise.all([prediction.palmLandmarks.data()]);
    const palmLandmarks =
        prediction.palmLandmarks.arraySync() as Array<[number, number]>;

    image.dispose();
    prediction.boxes.dispose();
    prediction.palmLandmarks.dispose();

    return scaleBoxCoordinates(
        {startPoint, endPoint, palmLandmarks},
        [inputWidth / this.width, inputHeight / this.height]);
  }
}
