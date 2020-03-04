'use strict';

const AWS = require('aws-sdk');
AWS.config.update({
  region: process.env.region
});

const dynamo = new AWS.DynamoDB.DocumentClient();
const dynamoRecordParser = AWS.DynamoDB.Converter;
const SQS = new AWS.SQS();
const Lambda = new AWS.Lambda();

const getLastRecordOperational = (hashId) => {
  return dynamo.query({
    TableName: process.env.tableNameOperational,
    ConsistentRead: true,
    ScanIndexForward: false,
    KeyConditionExpression: 'hashId = :hkey',
    ExpressionAttributeValues: {
      ':hkey': hashId,
    }
  }).promise()
  .then((data) => {
    return data.Items && data.Items.length ? data.Items[0] : null;
  })
  .catch((err) => {
    console.error("Error:", err);
    return err;
  })
}

const pad = (number, factor) => {
  return (number < Math.pow(10,factor) ? '0' : '') + (factor == 2 && number < 10 ? '0': '') + number;
};

const dateToString = (dt) => {
  const date = dt.getUTCFullYear()
    + '-' + pad(dt.getUTCMonth()+1,1)
    + '-' + pad(dt.getUTCDate(),1)
    + ' ' + pad(dt.getUTCHours(),1)
    + ':' + pad(dt.getUTCMinutes(),1)
    + ':' + pad(dt.getUTCSeconds(),1)
    + '.' + pad(dt.getUTCMilliseconds(),2);

  return date;
};

const existsItemByStatus = (hashId, isStatus) => {
  return dynamo.query({
    TableName: process.env.tableNameOperational,
    IndexName: process.env.indexNameOperational,
    ConsistentRead: true,
    KeyConditionExpression: 'hashId = :hkey and isStatus = :skey',
    ExpressionAttributeValues: {
      ':hkey': hashId,
      ':skey': isStatus
    }
  }).promise()
  .then((data) => {
    return data.Items && data.Items.length ? true : false;
  }).catch((err) => {
    throw err;
  });
}

const getSQSUrl = (prefix) => {
  return SQS.listQueues({
    QueueNamePrefix: prefix
  }).promise()
  .then((data) => {
    return data.QueueUrls[0];
  })
  .catch((err) => {
    console.error("Error SQS:", err);
    throw err;
  });
}

const getMessageQueue = async(prefix, queueUrl) => {
  const queueUrlMessage = prefix ? await getSQSUrl(prefix) : queueUrl;
  return SQS.receiveMessage({
    QueueUrl: queueUrlMessage
  }).promise()
  .then((data) => {
    return data && data.Messages && data.Messages.length ? data.Messages[0] : {};
  })
  .catch((err) => {
    console.error("Error:", err);
    throw err;
  });
}

const execLambda = (lambdaToCall, data) => {
  return Lambda.invoke({
    FunctionName: lambdaToCall,
    InvocationType: 'Event',
    Payload: JSON.stringify(data)
  }).promise()
  .then((data) => {
    return data;
  })
  .catch((err) => {
    console.error("Error Lambda:", err);
    throw err;
  })
}

const getOperationalFromMessage = (message, record) => {
  return dynamo.query({
    TableName: process.env.tableNameOperational,
    KeyConditionExpression: 'hashId = :hkey and execDateTime = :skey',
    ExpressionAttributeValues: {
      ':hkey': message.prefix + "-" + message.countryCode + "-" + message.docType,
      ':skey': message.execDateTime
    }
  }).promise()
  .then((data) => {
    let response = null;
    if(data.Items && data.Items.length){
      response = data.Items[0];
      response.fromDateTime = record && record.toDateTime ? record.toDateTime : response.fromDateTime;
      response.toDateTime = record && record.toDateTime ? dateToString(new Date()) : response.toDateTime;
    }

    return response;
  })
  .catch((err) => {
    console.error("Error:", err);
    throw err;
  })
}

const deleteMessageQueue = (queueUrl, receiptHandle) => {
  return SQS.deleteMessage({
    QueueUrl: queueUrl,
    ReceiptHandle: receiptHandle
  }).promise()
  .then((data) => {
    return data;
  })
  .catch((err) => {
    console.error("Error:", err);
    throw err;
  })
}

exports.handler = async (event, context, callback) => {
  console.log("Mensaje de entrada:", JSON.stringify(event, null, 2));
  let message = {};
  try {
    if(event.receiptHandle){
      message = await getMessageQueue(null, event.queueUrl);
      await deleteMessageQueue(event.queueUrl, message.ReceiptHandle);
      callback();
      return;
    }

    let record = dynamoRecordParser.unmarshall(event.Records[0].dynamodb.Keys);
    let recordNewImage = dynamoRecordParser.unmarshall(event.Records[0].dynamodb.NewImage);
    const noAcceptedStatus = process.env.noAcceptedStatus.split(",");
    let failedStatus = false;
    if(record.hashId.indexOf(process.env.countryCode.toLowerCase()) === -1 || event.Records[0].eventName == "REMOVE"){
      callback();
      return;
    }

    if(event.Records[0].eventName == 'INSERT'){
      for (let i = 0; i < noAcceptedStatus.length; i++) {
        failedStatus = await existsItemByStatus(record.hashId, noAcceptedStatus[i])
        if(failedStatus){
          callback();
          return;
        };
      }

      const lastRecord = await getLastRecordOperational(record.hashId);
      message = await getMessageQueue(record.hashId, null);
      let messageBodyWithReceiptHandle = null;
      if (message != null) {
        messageBodyWithReceiptHandle = JSON.parse(message.Body);
        messageBodyWithReceiptHandle.receiptHandle = message.ReceiptHandle;
      } else {
        callback();
        return;
      }

      let payload = {
        operational: lastRecord,
        message: messageBodyWithReceiptHandle,
        sqlConfigFile: messageBodyWithReceiptHandle.sqlConfigFilePre,
        presetData: [{
          fromDateTime: record.fromDateTime,
          toDateTime: record.toDateTime
        }]
      }

      await execLambda(process.env.lambdaToCall, payload);

    }else {
      if (event.Records[0].eventName == 'MODIFY' || event.Records[0].eventName == 'REMOVE') {
        callback(null);
        return;
      }
      if(recordNewImage.isStatus != process.env.statusError && recordNewImage.isStatus != process.env.statusOk){
        callback();
        return;
      }

      message = await getMessageQueue(record.hashId);
      record = recordNewImage.isStatus == process.env.statusOk ? await getOperationalFromMessage(JSON.parse(message.Body), record) : record;
      if(record && JSON.parse(message.Body).execDateTime == record.execDateTime){
        let messageBodyWithReceiptHandle = JSON.parse(message.Body);
        messageBodyWithReceiptHandle.receiptHandle = message.ReceiptHandle;

        let payload = {
          operational: record,
          message: messageBodyWithReceiptHandle,
          sqlConfigFile: messageBodyWithReceiptHandle.sqlConfigFilePre,
          presetData: [{
            fromDateTime: recordNewImage.fromDateTime,
            toDateTime: recordNewImage.toDateTime
          }]
        }
        console.log("Mensaje de salida: ", payload);
        await execLambda(process.env.lambdaToCall, payload);
      }
    }

    callback();
  } catch (e) {
    console.error(e);
    message = await getMessageQueue(null, event.queueUrl);
    await deleteMessageQueue(event.queueUrl, message.ReceiptHandle);
    await execLambda(
      process.env.lambdaGetErrors,
      {lambdaName: process.env.lambdaInitGetPaymentsAR, message: e.stack
    });
    callback(e);
  }
}