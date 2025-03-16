import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";

const cloudFormationClient = new CloudFormationClient({ region: process.env.AWS_REGION });

export async function getStackOutputs(stackName: string) {
  try {
    const command = new DescribeStacksCommand({ StackName: stackName });
    const response = await cloudFormationClient.send(command);

    if (response.Stacks && response.Stacks.length > 0) {
      const outputs = response.Stacks[0].Outputs;
      if (outputs) {
        return outputs.reduce((acc: Record<string, string>, output) => {
          if (output.OutputKey && output.OutputValue) {
            acc[output.OutputKey] = output.OutputValue;
          }
          return acc;
        }, {});
      }
    }
    return {};
  } catch (error) {
    console.error("Error fetching stack outputs:", error);
    return {};
  }
}
