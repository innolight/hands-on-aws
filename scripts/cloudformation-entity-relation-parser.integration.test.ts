/**
 * Integration tests for cloudformation-entity-relation-parser.ts
 *
 * These tests run the full pipeline against real cloud_formation*.yaml files
 * from the patterns directory and assert on the full formatted text output
 * via Jest snapshots.
 *
 * Unlike cloudformation-entity-relation-parser.test.ts, fs is NOT mocked here.
 * To update snapshots: npx jest --updateSnapshot
 */

import * as path from 'path';
import { runPipeline } from './cloudformation-entity-relation-parser';

const PATTERNS_DIR = path.resolve(__dirname, '../patterns');

describe('integration: s3-lambda-rekognition-dynamodb', () => {
  it('matches snapshot', () => {
    expect(runPipeline(path.join(PATTERNS_DIR, 's3-lambda-rekognition-dynamodb'))).toMatchSnapshot();
  });
});

describe('integration: dynamodb-stream-lambda', () => {
  it('matches snapshot', () => {
    expect(runPipeline(path.join(PATTERNS_DIR, 'dynamodb-stream-lambda'))).toMatchSnapshot();
  });
});

describe('integration: containers/ecs-fargate-apigw (multi-stack)', () => {
  it('matches snapshot', () => {
    expect(runPipeline(path.join(PATTERNS_DIR, 'containers/ecs-fargate-apigw'))).toMatchSnapshot();
  });
});

describe('integration: s3-events-notification', () => {
  it('matches snapshot', () => {
    expect(runPipeline(path.join(PATTERNS_DIR, 's3-events-notification'))).toMatchSnapshot();
  });
});
