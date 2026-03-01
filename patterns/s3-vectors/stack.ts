import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';

export const s3VectorsStackName = 'S3Vectors';

// CSV embeddings → PutVectors to S3 Vector Bucket → QueryVectors for similarity search
export class S3VectorsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VectorBucket is the top-level resource — analogous to an S3 bucket but
    // purpose-built for storing and querying high-dimensional vectors.
    // !! Change the following in production: omitting a deletion policy defaults
    // to RETAIN, which prevents accidental data loss. Set DELETE explicitly only
    // after confirming the bucket is empty.
    // !Ref on AWS::S3Vectors::VectorBucket returns the ARN, not the name.
    // Store the name separately so it can be passed to CfnIndex and CfnOutput,
    // both of which need the plain name (not ARN) for API calls.
    const bucketName = `food-reviews-${this.account}-${this.region}`;
    const indexName = 'food-reviews';

    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: bucketName,
    });
    vectorBucket.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.DELETE;

    // CfnIndex (L1) lives inside a VectorBucket and defines the vector schema.
    // dimension=1536 matches OpenAI ada-002 embeddings used in the dataset.
    // cosine distance is standard for text embeddings — measures angle between
    // vectors, ignoring magnitude. Use euclidean for image/audio embeddings where
    // magnitude matters.
    // dataType=float32 matches how ada-002 outputs embeddings (32-bit floats).
    const index = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: bucketName,
      indexName,
      dataType: 'float32',
      dimension: 1536,
      distanceMetric: 'cosine',
      metadataConfiguration: {
        // nonFilterableMetadataKeys are stored alongside the vector but not
        // indexed for filtering — cheaper to store, can't be used in filters.
        // All other metadata keys (Score, Summary, ProductId) are filterable by default.
        // Text is large and not useful as a query filter.
        nonFilterableMetadataKeys: ['Text'],
      },
    });

    // VectorIndex must be created after VectorBucket
    index.addDependency(vectorBucket);

    new cdk.CfnOutput(this, 'VectorBucketName', {value: bucketName});
    new cdk.CfnOutput(this, 'IndexName', {value: indexName});
  }
}
