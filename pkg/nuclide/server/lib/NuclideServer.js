'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

const blocked = require('./blocked');
const connect = require('connect');

const http = require('http');
const https = require('https');
import {
  HEARTBEAT_CHANNEL,
  SERVICE_FRAMEWORK3_CHANNEL} from './config';
const {EventEmitter} = require('events');
const WebSocketServer = require('ws').Server;
const {deserializeArgs, sendJsonResponse, sendTextResponse} = require('./utils');
const {getVersion} = require('nuclide-version');
import invariant from 'assert';
import ServiceFramework from './serviceframework';

import {getLogger, flushLogsAndExit} from 'nuclide-logging';
const logger = getLogger();




const EVENT_HANDLE_REGISTERED = '_nuclideServerEventHandleRegstered';


type NuclideServerOptions = {
  port: number;
  serverKey: ?Buffer;
  serverCertificate: ?Buffer;
  certificateAuthorityCertificate: ?Buffer;
  trackEventLoop: ?boolean;
}

export type SocketClient = {
  id: string;
  subscriptions: {[channel: string]: (event: any) => void};
  socket: ?WebSocket;
};

type ServiceConfig = {
  name: string;
  definition: string;
  implementation: string;
}

class NuclideServer {
  static _theServer: ?NuclideServer;

  _webServer: http.Server | https.Server;
  _webSocketServer: WebSocketServer;
  _clients: {[clientId: string]: SocketClient};
  _eventSubscriptions: Map</* eventName */ string, Set</* clientId */ string>>;
  _port: number;

  _serverComponent: ServiceFramework.ServerComponent;

  constructor(options: NuclideServerOptions) {
    invariant(NuclideServer._theServer == null);
    NuclideServer._theServer = this;

    const {serverKey, serverCertificate, port, certificateAuthorityCertificate, trackEventLoop} = options;

    this._app = connect();
    this._attachUtilHandlers(this._app);
    if (serverKey && serverCertificate && certificateAuthorityCertificate) {
      const webServerOptions = {
        key: serverKey,
        cert: serverCertificate,
        ca: certificateAuthorityCertificate,
        requestCert: true,
        rejectUnauthorized: true,
      };

      this._webServer = https.createServer(webServerOptions, this._app);
    } else {
      this._webServer = http.createServer(this._app);
    }
    this._port = port;

    this._webSocketServer = this._createWebSocketServer();
    this._clients = {};
    this._eventSubscriptions = new Map();

    this._setupServices(); // Setup 1.0 and 2.0 services.

    if (trackEventLoop) {
      blocked((ms: number) => {
        logger.info('NuclideServer event loop blocked for ' + ms + 'ms');
      });
    }

    // Setup 3.0 services.
    this._serverComponent = new ServiceFramework.ServerComponent(this);
  }

  _attachUtilHandlers(app) {
    // Add specific method handlers.
    ['get', 'post', 'delete', 'put'].forEach((methodName) => {
      this._app[methodName] = (uri, handler) => {
        this._app.use(uri, (request, response, next) => {
          if (request.method.toUpperCase() !== methodName.toUpperCase()) {
            // skip if method doesn't match.
            return next();
          } else {
            handler(request, response, next);
          }
        });
      };
    });
  }

  _createWebSocketServer(): WebSocketServer {
    const webSocketServer = new WebSocketServer({server: this._webServer});
    webSocketServer.on('connection', (socket) => this._onConnection(socket));
    webSocketServer.on('error', (error) => logger.error('WebSocketServer Error:', error));
    return webSocketServer;
  }

  _setupServices() {
    // Lazy require these functions so that we could spyOn them while testing in
    // ServiceIntegrationTestHelper.
    this._serviceRegistry = {};
    this._version = getVersion().toString();
    this._setupHeartbeatHandler();

    // Setup error handler.
    this._app.use((error, request, response, next) => {
      if (error) {
        sendJsonResponse(response, {code: error.code, message: error.message}, 500);
      } else {
        next();
      }
    });
  }

  _setupHeartbeatHandler() {
    this._registerService('/' + HEARTBEAT_CHANNEL, async () => this._version,
        'post', true);
  }

  static shutdown(): void {
    logger.info('Shutting down the server');
    try {
      if (NuclideServer._theServer != null) {
        NuclideServer._theServer.close();
      }
    } catch (e) {
      logger.error('Error while shutting down, but proceeding anyway:', e);
    } finally {
      flushLogsAndExit(0);
    }
  }

  connect(): Promise {
    return new Promise((resolve, reject) => {
      this._webServer.on('listening', () => {
        resolve();
      });
      this._webServer.on('error', (e) => {
        this._webServer.removeAllListeners();
        reject(e);
      });
      this._webServer.listen(this._port);
    });
  }

  /**
   * Calls a registered service with a name and arguments.
   */
  callService(serviceName: string, args: Array<any>): Promise<any> {
    const serviceFunction = this._serviceRegistry[serviceName];
    if (!serviceFunction) {
      throw Error('No service registered with name: ' + serviceName);
    }
    return serviceFunction.apply(this, args);
  }

  /**
   * Registers a service function to a service name.
   * This allows simple future calls of the service by name and arguments or http-triggered endpoint calls
   * with arguments serialized over http.
   */
  _registerService(
      serviceName: string,
      serviceFunction: () => Promise<any>,
      method: ?string = 'get',
      isTextResponse: ?boolean) {
    if (this._serviceRegistry[serviceName]) {
      throw new Error('A service with this name is already registered:', serviceName);
    }
    this._serviceRegistry[serviceName] = serviceFunction;
    this._registerHttpService(serviceName, method, isTextResponse);
  }

  _registerHttpService(serviceName: string, method: string, isTextResponse: ?boolean) {
    const loweredCaseMethod = method.toLowerCase();
    this._app[loweredCaseMethod](serviceName, async (request, response, next) => {
      try {
        const result = await this.callService(serviceName, deserializeArgs(request.url));
        if (isTextResponse) {
          sendTextResponse(response, result || '');
        } else {
          sendJsonResponse(response, result);
        }
      } catch(e) {
        // Delegate to the registered connect error handler.
        next(e);
      }
    });
  }

  /**
   * Attach an explicit http connect handler for some services that need request/response related optimizations.
   * e.g. readFile and writeFile uses it to stream reading and writing files (perf improvement for big files).
   */
  _attachUrlHandler(
    url: string,
    handler: (request: http.IncomingMessage, response: http.OutgoingMessage, next: (err: Error) => void) => void,
    method: ?string = 'get'
  ): void {
    this._app[method](url, handler);
  }

  _onConnection(socket: WebSocket): void {
    logger.debug('WebSocket connecting');


    let client = null;

    socket.on('error', (e) =>
      logger.error('Client #%s error: %s', client ? client.id : 'unkown', e.message));

    socket.once('message', (clientId) => {
      client = this._clients[clientId] = this._clients[clientId] ||
          {subscriptions: {}, id: clientId, messageQueue: []};
      // If an existing client, we close its socket before listening to the new socket.
      if (client.socket) {
        client.socket.close();
        client.socket = null;
      }
      logger.info('Client #%s connecting with a new socket!', clientId);
      client.socket = socket;
      client.messageQueue.splice(0).forEach(message => this._sendSocketMessage(client, message.data));
      socket.on('message', (message) => this._onSocketMessage(client, message));
    });

    socket.on('close', () => {
      if (!client) {
        return;
      }
      if (client.socket === socket) {
        client.socket = null;
      }
      logger.info('Client #%s closing a socket!', client.id);
      // TODO: enable subscription cleanup when we have a robust reconnect scenario.
      /*
      for (var channel in client.subscriptions) {
        this.unsubscribe(channel, subscriptions[channel]);
      }
      this._eventSubscriptions.forEach(value => value.delete(client.id));
      delete this._clients[client.id];
      */
    });
  }

  async _onSocketMessage(client: SocketClient, message: any): void {
    message = JSON.parse(message);
    invariant(message.protocol && message.protocol === SERVICE_FRAMEWORK3_CHANNEL);
    this._serverComponent.handleMessage(client, message);
  }

  _sendSocketMessage(client: SocketClient, data: any) {
    // Wrap the data in an object, because if `data` is a primitive data type,
    // finding it in an array would return the first matching item, not necessarily the same inserted item.
    const message = {data};
    const {id, socket, messageQueue} = client;
    messageQueue.push(message);
    if (!socket) {
      return;
    }
    socket.send(JSON.stringify(data), (err) => {
      if (err) {
        logger.warn('Failed sending socket message to client:', id, data);
      } else {
        const messageIndex = messageQueue.indexOf(message);
        if (messageIndex !== -1) {
          messageQueue.splice(messageIndex, 1);
        }
      }
    });
  }

  close() {
    invariant(NuclideServer._theServer === this);
    NuclideServer._theServer = null;

    this._webSocketServer.close();
    this._webServer.close();
  }
}

module.exports = NuclideServer;
