'use strict';

let AWS = require('aws-sdk');
AWS.config.update({
    region: process.env.region
});
const dynamo = new AWS.DynamoDB.DocumentClient();

const putItem = (itemData) => {
    let params = {
        TableName: process.env.tableNameTemporaryPayments,
        Item: itemData,
        ScanIndexForward: false
    };

    return dynamo.put(params).promise()
        .then((data) => {
            console.log("Exito al insertar tableNameTemporaryPayments: ", data);
            return data;
        }).catch((e) => {
            console.error("Error al insertar tableNameTemporaryPayments: ", e);
            return e;
        });
};

exports.handler = async (event, context, callback) => {
    console.log('Mensaje de entrada : ', JSON.stringify(event, null, 2));
    try {
        let payment = event;
        payment.organization_code = event.organizationCode;
        await putItem(payment);
    } catch (e) {
        let err = typeof e == 'string' ? e : e.stack;
        let errStack = JSON.stringify(err).replace(/\\n/g, "");
        console.error("Error lambda : ", errStack);
        callback(null);
        return;
    }

};
