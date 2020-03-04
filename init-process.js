'use strict';

const AWS = require('aws-sdk');
AWS.config.update({
  region: process.env.region
});

const S3 = new AWS.S3();
const SQS = new AWS.SQS();
const Lambda = new AWS.Lambda();

const getSQSQueues = (prefix) => {
  return SQS.listQueues({
    QueueNamePrefix: prefix + '-' + process.env.countryCode.toLowerCase()
  }).promise()
  .then((data) => {
    // Array <String>
    console.log("Data getSQSQueues: ", data);
    return data.QueueUrls && data.QueueUrls.length ? data.QueueUrls : [];
  })
  .catch((err) => {
    console.error("Error SQS:", err);
    return [];
  });
}

const getEnvironmentData = () => {
  const dataByDocType = [];
  const doctypes = process.env.doctypes.split(",").sort();
  const maxQueuesByTypeDoc = process.env.sqsMaxQueues.split(",").sort();
  for (let i = 0; i < doctypes.length; i++) {
    const data = {};
    data.countryCode = process.env.countryCode;
    data.execDateTime = dateToString(new Date());
    data.prefix = process.env.prefix;
    data.lambdaToCallOnError = process.env.lambdaToError;
    data.doctype = doctypes[i];
    data.sqsMaxQueues = maxQueuesByTypeDoc[i].split("_")[1];
    data.sqlConfigFile1 = process.env.sqlConfigFilePre;
    data.sqlConfigFile2 = process.env.sqlConfigFilePost;
    dataByDocType.push(data);
  }
  return dataByDocType;
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

const existsInvoicingFile = () => {
  return S3.listObjectsV2({
    Bucket: process.env.bucketName,
    Prefix: process.env.folderNameInvoice
  }).promise()
  .then((data) => {
    return data.Contents.length;
  })
  .catch((err) => {
    console.error("Error S3:", err);
    throw err;
  });
}

const createFileToInvoice = () => {
  S3.putObject({
    Body: "¡¡¡Exodia manifiestate!!!",
    Bucket: process.env.bucketName + '/' + process.env.folderNameInvoice,
    Key: process.env.filenameInvoice
  }).promise()
  .then((data) => {
    return data;
  })
  .catch((err) => {
    console.error("Error S3:", err);
    throw err;
  });
}

const execLambda = (lambdaToCall, data) => {
  return Lambda.invoke({
    FunctionName: lambdaToCall,
    InvocationType: 'Event',
    Payload: data
  }).promise()
  .then((data) => {
    return data;
  })
  .catch((err) => {
    console.error("Error Lambda:", err);
    throw err;
  })
}

const getSQSToDelete = (queueNames, docTypes) => {
  const sqsToDelete = [];
  for (let i = 0; i < queueNames.length; i++) {
    const splitQueueName = queueNames[i].split("-");
    const docTypeSQS = splitQueueName[splitQueueName.length - 1].split(".")[0];
    const docType = docTypes.map((doc) => {return doc.doctype});
    if(docType.indexOf(docTypeSQS) != -1) continue;
    sqsToDelete.push(queueNames[i]);
  }

  return sqsToDelete;
}

const getSQSToCreateOrEnqueue = (queueNames, docTypes) => {
  const sqsData = {
    sqsToCreate: {
      lambdaToCall: process.env.lambdaToEnqueue,
      lambdaToCallOnError: process.env.lambdaToError,
      queues: []
    },
    sqsToEnqueue: []
  };

  for (let i = 0; i < docTypes.length; i++) {
    const queueName = process.env.prefix + "-" + docTypes[i].countryCode.toLowerCase() + '-' + docTypes[i].doctype; 
    const indexQueueName = queueNames.indexOf(queueName);
    if(indexQueueName === -1){
      docTypes[i].lambdaToCall = process.env.lambdaCreateProvisionalOperational;
      sqsData.sqsToCreate.queues.push({
        data: [docTypes[i]],
        queueName: queueName,
        suffix: '.fifo',
      });
    } else {
      sqsData.sqsToEnqueue.push({
        data: [docTypes[i]],
        queueUrl: queueNames[indexQueueName],
        lambdaToCall: process.env.lambdaToProvisionalOperational,
        lambdaToCallOnError: process.env.lambdaToError
      });
    }
  }

  return sqsData;
}

exports.handler = async (event, context, callback) => {
  console.log("Event:", JSON.stringify(event));
  try {
    const queues = await getSQSQueues(process.env.prefix);
    // const existFile = await existsInvoicingFile();
    const docTypesConfig = getEnvironmentData();
    const sqsToDelete = getSQSToDelete(queues, docTypesConfig);
    let sqsToDeleteObj = { queueUrls: sqsToDelete };
    const sqsData = getSQSToCreateOrEnqueue(queues, docTypesConfig);

    // if(existFile == 0){
    //   const payload = {
    //     queueName: process.env.sqsPrefixToInvoice + "-" + process.env.countryCode.toLowerCase()
    //   };

    //   await createFileToInvoice();
    //   await execLambda(process.env.lambdaToInitInvoicing, JSON.stringify(payload));
    // }
    console.log("Mensaje de salida: ", JSON.stringify(sqsData, null, 2));
    await execLambda(process.env.lambdaToCreateQueues, JSON.stringify(sqsData.sqsToCreate));
    await execLambda(process.env.lambdaToEnqueue, JSON.stringify(sqsData.sqsToEnqueue));
    await execLambda(process.env.lambdaToDeleteQueues, JSON.stringify(sqsToDeleteObj));
    callback(null);
  } catch (e) {
    await execLambda(
      process.env.lambdaGetErrors,
      JSON.stringify({lambdaName: process.env.lambdaInitProcessAR, message: e.stack
    }));
    callback(e);
  }
}