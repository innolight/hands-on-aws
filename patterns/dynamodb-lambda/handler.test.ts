import {handler} from './handler';
import {DynamoDBStreamEvent} from 'aws-lambda';

describe('Lambda Handler', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('should process INSERT event', async () => {
    const event: Partial<DynamoDBStreamEvent> = {
      Records: [
        {
          eventID: '1',
          eventName: 'INSERT',
          dynamodb: {
            NewImage: {
              orderId: {S: 'order-1'},
              status: {S: 'PENDING'},
              amount: {N: '100'}
            }
          }
        }
      ]
    };

    await handler(event as DynamoDBStreamEvent);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('EventName: INSERT'));
    expect(logSpy).toHaveBeenCalledWith('New Image:', expect.stringContaining('order-1'));
  });

  test('should detect status change from PENDING to PAID', async () => {
    const event: Partial<DynamoDBStreamEvent> = {
      Records: [
        {
          eventID: '2',
          eventName: 'MODIFY',
          dynamodb: {
            OldImage: {
              orderId: {S: 'order-2'},
              status: {S: 'PENDING'}
            },
            NewImage: {
              orderId: {S: 'order-2'},
              status: {S: 'PAID'}
            }
          }
        }
      ]
    };

    await handler(event as DynamoDBStreamEvent);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[ACTION] Order order-2 was PAID!'));
  });

  test('should throw error for "FAIL" orderId (poison pill)', async () => {
    const event: Partial<DynamoDBStreamEvent> = {
      Records: [
        {
          eventID: '3',
          eventName: 'INSERT',
          dynamodb: {
            NewImage: {
              orderId: {S: 'FAIL-999'},
              status: {S: 'PENDING'}
            }
          }
        }
      ]
    };

    await expect(handler(event as DynamoDBStreamEvent)).rejects.toThrow('Poison pill detected: FAIL-999');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Simulating failure'));
  });

  test('should process REMOVE event', async () => {
    const event: Partial<DynamoDBStreamEvent> = {
      Records: [
        {
          eventID: '4',
          eventName: 'REMOVE',
          dynamodb: {
            OldImage: {
              orderId: {S: 'order-4'},
              status: {S: 'PAID'}
            }
          }
        }
      ]
    };

    await handler(event as DynamoDBStreamEvent);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('EventName: REMOVE'));
    expect(logSpy).toHaveBeenCalledWith('Old Image:', expect.stringContaining('order-4'));
  });
});
