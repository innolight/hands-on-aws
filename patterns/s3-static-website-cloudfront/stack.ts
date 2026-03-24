import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

export const s3StaticWebsiteCloudfrontStackName = 'S3StaticWebsiteCloudfront';

// S3StaticWebsiteCloudfrontStack hosts a static website on a private S3 bucket,
// served globally through CloudFront using Origin Access Control (OAC).
export class S3StaticWebsiteCloudfrontStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Private S3 bucket — no public access. CloudFront accesses it via OAC.
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: `s3-static-website-cf-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      //  !! Change the following in production.
      // This deletes the bucket when the stack is deleted (for easy cleanup).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution with Origin Access Control (OAC).
    // S3BucketOrigin.withOriginAccessControl() automatically:
    //   1. Creates an OAC resource
    //   2. Attaches a bucket policy granting CloudFront read access
    // This replaces the legacy Origin Access Identity (OAI) approach.
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      // Serves index.html for requests to the root URL ("/").
      // This replaces S3's websiteIndexDocument — which is incompatible with OAC.
      defaultRootObject: 'index.html',
      // US, Canada, Europe only — cheapest option, sufficient for development.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // Deploy a sample index.html so the pattern works immediately after cdk deploy.
    // Source.data() writes an inline string — no local asset directory needed.
    //
    // For a real frontend project (React, Vue, etc.), replace Source.data() with:
    //   sources: [s3deploy.Source.asset('./frontend/dist')]
    // CDK zips the directory, uploads it to the bootstrap assets bucket, then a
    // Lambda extracts and copies all files into the website bucket during deploy.
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.data('index.html', '<html><body><h1>Hello from S3 + CloudFront</h1></body></html>')],
      destinationBucket: websiteBucket,
      // Invalidate CloudFront cache on deploy so updates are visible immediately.
      distribution,
      distributionPaths: ['/*'],
    });

    // Outputs
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'BucketName', { value: websiteBucket.bucketName });
  }
}
