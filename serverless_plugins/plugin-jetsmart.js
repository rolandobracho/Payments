'use strict';

const aws = require('aws-sdk');
const fs = require("fs");
const yaml = require('js-yaml');

aws.config.update({
  region: 'us-east-2',
});

const cwl = new aws.CloudWatchLogs();
const sleep = require('util').promisify(setTimeout);

const taskStatusCodes = ['COMPLETED', 'FAILED'];
const timeoutMs = 5000;
const logGroupNamePrefix = '/aws/lambda/'// + yamlObj.service;
const bucketNameLogs = 'jat-facturacion-logs'
const countries = ['cl', 'ar'];

let dynamodbstreams = new aws.DynamoDBStreams();
let sqs = new aws.SQS();

const getTaskProgresStatus = async (taskId) => {
  console.info('Obteniendo estado de progreso de tarea de exportación de logs con id "' + taskId +'"');
  await cwl.describeExportTasks({
      taskId: taskId
    }).promise()
    .then(async (data) => {
      if(taskStatusCodes.includes(data.exportTasks[0].status.code)) {
        console.info('Ha finalizado la tarea de exportación de logs con id "' + taskId +'". Estado "' + data.exportTasks[0].status.code + '"');
        return;
      }
      console.info('Aún no finaliza la tarea de exportación de logs con id "' + taskId +'". Estado "' + data.exportTasks[0].status.code + '"');
      await sleep(timeoutMs);
      await getTaskProgresStatus(taskId);
    })
    .catch((err) => {
      console.error('Ha ocurrido un error al intentar obtener el estado de la tarea de exportación de logs con id "' + taskId +'"', err);
      return;
    });
}


const backupLogs = async (serverless, options) => {
  let service = serverless.service.service;
  console.info('Iniciando exportación de logs asociados a stack. Buscando stream logs con prefijo "' + logGroupNamePrefix + service + '"');
  await cwl.describeLogGroups({
    logGroupNamePrefix: logGroupNamePrefix + service + '-' + options.stage
  }).promise()
  .then(async (data) => {
    console.info('Obteniendo información sobre logGroups asociados al prefijo "' + logGroupNamePrefix + service + '" (cantidad: ' + data.logGroups.length + ')');
    for (let i = 0; i < data.logGroups.length; i++) {
      let taskOptions = {
        destination: bucketNameLogs,
        from: data.logGroups[i].creationTime,
        logGroupName: data.logGroups[i].logGroupName,
        to: Date.now()
      };

      console.debug('Objeto con parámetros para creación de tarea de exportación de logs', taskOptions);
      await cwl.createExportTask(taskOptions).promise()
      .then(async (subData) => {
        console.info('Se ha generado una tarea de exportación de logs para el stream "' + data.logGroups[i].logGroupName + '" con id "' + subData.taskId + '"');
        await getTaskProgresStatus(subData.taskId);
      })
      .catch((subErr) => {
        console.error('Ha ocurrido un error al intentar generar la tarea de exportación de logs para el stream "' + data.logGroups[i].logGroupName + '"', subErr);
        return;
      })  
    }
  })
  .catch((err) => {
    console.error('Ha ocurrido un error al intentar obtener los stream logs asociados al prefijo "' + logGroupNamePrefix + service + '"', err);
    return;
  })
}

const getSQSArn = (queueName, queueSQS, yamlObj) => {

  let params = {
    QueueName: queueName
  };
  return new Promise((resolve, reject) => {
    sqs.getQueueUrl(params, function (err, data) {
      if (err) console.log(err, err.stack);
      else {
        let paramsAttr = {
          QueueUrl: data.QueueUrl,
          AttributeNames: ['QueueArn']
        };

        sqs.getQueueAttributes(paramsAttr, function (err, dataArn) {
          if (err) console.log(err, err.stack);
          else{
            if(dataArn && dataArn.Attributes){
              console.log("SQS ARN: ", dataArn.Attributes.QueueArn);
              yamlObj[queueSQS] = dataArn.Attributes.QueueArn;
            }
          }
          resolve(yamlObj);
        });
      }
    });
  });
};

const getStreamArnName = (tableNameServerless,tableName, yamlObj) => {

  let params = {
    TableName : tableName
  };

  return new Promise((resolve, reject) => {
    dynamodbstreams.listStreams(params, function (err, data) {
      if (err) console.log(err, err.stack);
      else{
        if(data.Streams.length) {
          console.log("StreamArn: ", data.Streams[0].StreamArn);
          yamlObj[tableNameServerless] = data.Streams[0].StreamArn;
        }
        resolve(yamlObj);
      }
    });
  });

};

const getData = async (serverless, options) => {
  let yamlObj = yaml.load(fs.readFileSync("../core/env_"+options.stage+".yml", {encoding: 'utf-8'}));
  let sqsEvents = serverless.service.custom.parameters.sqsEvents;
  let streamEvents = serverless.service.custom.parameters.streamEvents ? serverless.service.custom.parameters.streamEvents : [];

  for (let i = 0; i < streamEvents.length; i++) {
    yamlObj = await getStreamArnName(streamEvents[i], serverless.service.custom.parameters[streamEvents[i]], yamlObj);
  }

  for (let i in sqsEvents) {
    yamlObj = await getSQSArn(sqsEvents[i], i, yamlObj);
  }
  
  let yamlString = yaml.safeDump(yamlObj);

  fs.writeFile("../core/env_"+options.stage+".yml", yamlString, (err) => {
      if (err) {
          console.error(err);
          return;
      }
      console.log("El archivo de ambiente CORE fue actualizado");
  });

  for (let i = 0; i < countries.length; i++) {
    fs.writeFile(countries[i] + "/env_"+options.stage+".yml", yamlString, (err) => {
      if (err) {
        console.error(err);
        return;
      }
      console.log("El archivo de ambiente fue actualizado");
    });
  }
  
};

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.commands = {
      welcome: {
          usage: 'Comando JetSmart',
      }
    };

    this.hooks = {
      'aws:deploy:deploy:updateStack': getData.bind(this, serverless, options),
      'before:remove:remove': backupLogs.bind(this, serverless, options)
    };
  }
}

module.exports = ServerlessPlugin;