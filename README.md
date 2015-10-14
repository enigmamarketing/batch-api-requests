# batch-api-requests

Module for doing parallel JSON HTTP requests with a single, persistent connection. The module includes both a Node.js client and Express 4 server middleware.

It's loosely based on the implementation described in the [oData Specification](http://www.odata.org/documentation/odata-version-3-0/batch-processing/) and [Google Batch Requests](https://cloud.google.com/storage/docs/json_api/v1/how-tos/batch?hl=en). 

## Client

Basic usage:

```
var batchClient = require('batch-api-requests').client,
	batchConnection = batchClient.connect({
		url: 'https://api.someserver.com/batch',
		headers: {
			Authorization: 'Bearer {{someToken}}''
		}
	}),
	items = [// an array of request objects
		{
            method: 'POST',
            path: '/test1',
            body: {
				name: 'John'
        	}
        }, {
            method: 'POST',
            path: '/test1',
            body: {
				name: 'Peter'
        	}
        }
	];
	
	// sending all items
	items.forEach(function (item) {
		batchConnection.send(item, function (error, body, response) {
            // handle item response...
            //
            // body: String
			// response: {
			//      statusCode: Number,
			//      statusMessage: String,
			//      headers: {}, 
			// }
        });
	});

	batchConnection.close();
```
**Remember to call the close method**

The last items may not be sent until you close the connection. 

Once the connection has been set as closed all consequent send calls will return an error and no message will be sent.

The connection may be unexpectedly dropped by the remote server. In that case some of the pending requests will be ignored and errors will be returned. There is the chance that the request has already been sent and processed by the remote server but we didn't receive the response due to the dropped connection. Any following send command will re-open the connection.

The callback on the send method is optional;

## Server

The middleware will act as a proxy, issuing an HTTP request for each one of the batched requests.

Basic usage:

```
var batchMiddleware = require('batch-api-requests').server,
	express = require('express'),
 	app = express(),
 	options = {};// check available options and it's default values

app.use('/batch', batchMiddleware(options));
```

### options.logger
A logger object with the following methods:

- error
- info
- warn

If no logger is provided console will be used.

Setting it as false will disable any reporting.

### options.parallelLimit
default value: 10

Maximum parallel requests that will be performed by the middleware, for each connection. This allows us to control the stress on the application servers. 

### options.retries
default value: 0

Setting this value will force a number of re-tries. All internal errors will be logged but only the last one will be returned to the client.

### options.protocol
The protocol to be used. By default 'https'. 

### options.timeout
Default value 5000. 

This is the timeout for the proxied request, not the batch connection. Each batch request will be performed internally on the server/datacenter, so a small timeout is acceptable.

