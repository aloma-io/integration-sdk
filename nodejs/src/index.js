require("dotenv").config();
const fs                = require('fs');
const {Config}          = require('./websocket/config');
const {Connection}      = require('./websocket/connection');
const {Transport}       = require('./websocket/transport');
const {Dispatcher}      = require('./dispatcher');
const {WebsocketConnector} = require('./websocket')
const JWE               = require('./util/jwe');
const fetch             = require('node-fetch');
const cuid              = require('@paralleldrive/cuid2').init({length: 32});

// TODO fetch with retry

const handlePacketError = (packet, e, transport) =>
{
  if (!packet.cb()) 
  {
    console.dir({msg: 'packet error', e, packet}, {depth: null})
    return;
  }

  transport.send(transport.newPacket({c: packet.cb(), a: {error: '' + e}}))
}

const reply = (arg, packet, transport) =>
{
  if (!packet.cb()) 
  {
    console.dir({msg: 'cannot reply to packet without cb', arg, packet}, {depth: null})
    return;
  }

  transport.send(transport.newPacket({c: packet.cb(), a: {...arg}}))
}

const unwrap = async (ret, options) =>
{
  if (options?.text) return await ret.text();
  if (options?.base64) return (await ret.buffer()).toString('base64');

  return await ret.json();  
};

class Fetcher
{
  constructor({oauth, retry = 5, getToken, baseUrl})
  {
    this.retry = retry;
    this.oauth = oauth;
    this._getToken = getToken;
    this.baseUrl   = baseUrl;
  }
  
  async getToken(force)
  {
    var local = this, oauth = local.oauth;
    
    if (local._getToken) return local._getToken(force);
    
    if (!force && oauth.accessToken()) return oauth.accessToken();
    
    const refreshToken = oauth.refreshToken();
    if (!refreshToken) throw new Error('have no access_token and no refresh_token');
    
    const ret = await oauth.obtainViaRefreshToken(oauth.refreshToken());
    
    if (ret.access_token)
    {
      oauth.update(ret.access_token, ret.refresh_token);
      
      return ret.access_token;
    } else {
      throw new Error('could not obtain access token via refresh token');
    }
  }
  
  async fetch({url, options = {}, forceTokenRefresh, retries})
  {
    var local = this, baseUrl = local.baseUrl;
    
    if (retries == null) retries = local.retry;
    
    try
    {
      const token = await local.getToken(forceTokenRefresh);
      
      options = {...options};
      options.headers = {...options.headers, Authorization: `Bearer ${token}`}
      
      const theURL = `${baseUrl?.endsWith('/')?baseUrl:baseUrl + '/'}${url}`.replace(/\/\/+/gi, "/");
      
      const ret    = await fetch(theURL, options);
      const status = await ret.status;

      if (status > 399)
      {
        const text = await ret.text();
        const e = new Error(status + ' ' + text);
        
        e.status = status;
        throw(e);
      }
      
      return unwrap(ret, options);
    } catch(e) {
      --retries;
      
      console.log(e);
      
      if (retries <= 0) throw e;
      
      return new Promise((resolve, reject) => 
      {
        setTimeout(async () => 
        {
          try
          {
            resolve(await local.fetch({url, options, forceTokenRefresh: e.status === 401, retries}));
          } catch(e) {
            reject(e);
          }
        }, 500);
      })
    }
  }
}

class OAuth
{
  constructor(data, saveOAuthResult, getRefreshToken)
  {
    var local = this;
    this._data = data || {};
    this.saveOAuthResult = saveOAuthResult;
    this.obtainViaRefreshToken = getRefreshToken;
  }
  
  data()
  {
    return this._data;
  }
  
  accessToken()
  {
    return this._data.access_token;
  }
  
  refreshToken()
  {
    return this._data.refresh_token;
  }
  
  async update(accessToken, refreshToken)
  {
    this._data.access_token = accessToken;
    
    if (refreshToken)
    {
      this._data.refresh_token = refreshToken;
    }
    
    await this.saveOAuthResult(this._data);
  }
  
  getClient(arg = {})
  { 
    return new Fetcher({...arg, oauth: this});
  }
}

class Connector
{
  constructor({version, id, name})
  {
    this.id      = id;
    this.version = version;
    this.name    = name;
  }
  
  configure()
  {
    return this.dispatcher = new Dispatcher();
  }
  
  async run()
  {
    var local = this;
    
    const makeMetrics = () =>
    {
      const metrics = require('prom-client')
    
      const defaultLabels = { service: local.name, connectorId: local.id, connectorVersion: local.version, node: process.env.HOSTNAME || 'test'};
      metrics.register.setDefaultLabels(defaultLabels);
      metrics.collectDefaultMetrics()
      
      return metrics;
    };

    const makeMetricsServer = (metrics) => {
      const app = require('express')();

      app.get('/metrics', async (request, response, next) => {
        response.status(200);
        response.set('Content-type', metrics.contentType);
        response.send(await metrics.register.metrics());
        response.end();
      });

      return app;
    };
    
    makeMetricsServer(makeMetrics()).listen(4050, '0.0.0.0');
    
    const {processPacket, start, introspect, configSchema} = this.dispatcher.build();
    
    const config                 = new Config
    ({
      id:               	this.id, 
      version:            this.version, 
      name:               process.env.HOSTNAME || this.name, 
      registrationToken:  process.env.REGISTRATION_TOKEN, 
      endpoint:           process.env.DEVICE_ENDPOINT    || 'https://connect.aloma.io/', 
      wsEndpoint:         process.env.WEBSOCKET_ENDPOINT || 'wss://transport.aloma.io/transport/',
      privateKey:         process.env.PRIVATE_KEY,
      publicKey:          process.env.PUBLIC_KEY,
      introspect,
      configSchema
    });
    
    if (Object.keys(configSchema().fields).length)
    {
      try
      {
        await config.validateKeys();
      } catch(e) {
        const haveKey = !!process.env.PRIVATE_KEY;
        const jwe     = new JWE({});
        var text      = 'Please double check the env variables';
      
        if (!haveKey) 
        {
          await jwe.newPair();
          text = "fresh keys generated, set environment variables: \n\nPRIVATE_KEY: " + await jwe.exportPrivateAsBase64() + "\n\nPUBLIC_KEY: " + await jwe.exportPublicAsBase64() + "\n"
        }
      
        console.log
        (`
Error: 

public (env.PUBLIC_KEY) and private key (env.PRIVATE_KEY) could not be loaded.
      
${text}
        `)
      
        return;
      }
    }
    
    const server          = new WebsocketConnector({config, onConnect: (transport) => 
    {
      local.dispatcher.onConfig = async function(secrets)
      {
        const decrypted = {};
        const fields    = configSchema().fields;
        
        const keys = Object.keys(secrets);
        const jwe  = await config.validateKeys('RSA-OAEP-256');
        
        for (var i = 0; i < keys.length; ++i)
        {
          const key   = keys[i];
          const value = secrets[key];
          if (!value) continue;
          
          if (fields[key]?.plain)
          {
            decrypted[key] = value;
          } else {
            try
            {
              decrypted[key] = (await jwe.decrypt(value, config.id()));
            } catch(e) {
              console.log('failed to decrypt key', key, config.id(), e);
            }
          }
        }
        
        this.startOAuth = async function(args)
        {
          if (!this._oauth) throw new Error('oauth not configured')
            
          const clientId = this._oauth.clientId || process.env.OAUTH_CLIENT_ID || decrypted.clientId;
          if (!clientId) throw new Error('clientId not configured');
          
          const scopes   = this._oauth.scope || process.env.OAUTH_SCOPE || decrypted.scope || '';
          
          return {url: this._oauth.authorizationURL.replace(/\{\{clientId\}\}/gi, encodeURIComponent(clientId)).replace(/\{\{scope\}\}/gi, encodeURIComponent(scopes))};
        }
        
        this.finishOAuth = async function(arg)
        {
          var that = this;
          
          if (!this._oauth) throw new Error('oauth not configured')
          if (!this._oauth.tokenURL && !this._oauth.finishOAuth) throw new Error('need tokenURL or finishOAuth(arg)');
          
          var data = null;  
          
          const doFinish = async () =>
          {
            if (!arg.code || !arg.redirectURI) throw new Error('need code and redirectUri');
            
            const clientId = that._oauth.clientId || process.env.OAUTH_CLIENT_ID || decrypted.clientId;
            if (!clientId) throw new Error('clientId not configured');
            
            const clientSecret = that._oauth.clientSecret || process.env.OAUTH_CLIENT_SECRET || decrypted.clientSecret;
            if (!clientSecret) throw new Error('clientSecret not configured');
            
            const additionalTokenArgs = that._oauth.additionalTokenArgs || {};
            const useAuthHeader = that._oauth.useAuthHeader || false;

            let body = {
              ...additionalTokenArgs,
              code:           arg.code,
              redirect_uri:   arg.redirectURI
            };

            let headers = { 
             'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              Accept: 'application/json'
            };

            if (useAuthHeader) {
              headers = { ...headers, Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`}
            } else {
              body = {...body, client_id: clientId, client_secret: clientSecret}
            }
            
            const response = await fetch
            (
              that._oauth.tokenURL, 
              {
                method: 'POST',
                body:    new URLSearchParams(body),
                headers
              }
            );
            
            const status = await response.status;
            const text   = await response.text();
            
            if (status === 200)
            {
              const ret = JSON.parse(text);
              if (ret.error)
              {
                throw new Error(`${status} ${ret.error} ${ret.error_description || ''}`)
              } else if (ret.access_token) {
                return  {...ret}
              } else {
                throw new Error(status + ' response has no access_token - ' + text);
              }
            } else {
              throw new Error(status + ' ' + text);
            }
          }
          
          if (this._oauth.finishOAuth)
          {
            data = await this._oauth.finishOAuth({arg, doFinish, transport});
          } else {
            data = await doFinish();
          }
          
          const jwe  = await config.validateKeys('RSA-OAEP-256');
          
          return {value: await jwe.encrypt(data, 'none', config.id())};
        }

        const saveOAuthResult = async (what) =>
        {
          const jwe     = await config.validateKeys('RSA-OAEP-256');
          const packet  = transport.newPacket({});
    
          packet.method('connector.config-update');
          packet.args({value: await jwe.encrypt(what, 'none', config.id())});
    
          transport.send(packet);
        };
        
        const that = this;
        
        const getRefreshToken = async (refreshToken) =>
        {
          const clientId = that._oauth.clientId || process.env.OAUTH_CLIENT_ID || decrypted.clientId;
          if (!clientId) throw new Error('clientId not configured');
          
          const clientSecret = that._oauth.clientSecret || process.env.OAUTH_CLIENT_SECRET || decrypted.clientSecret;
          if (!clientSecret) throw new Error('clientSecret not configured');
          
          const response = await fetch
          (
            that._oauth.tokenURL, 
            {
              method: 'POST',
              body:    new URLSearchParams
              ({
                grant_type:     'refresh_token',
                refresh_token:  refreshToken,
                client_id:      clientId,
                client_secret:  clientSecret
              }),
              headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json'},
            }
          );
          
          const status = await response.status;
          const text   = await response.text();
          
          if (status === 200)
          {
            return JSON.parse(text);
          } else {
            throw new Error('could not get refresh token ' + status + ' ' + text);
          }
        }
        
        start({config: decrypted, oauth: new OAuth(decrypted.oauthResult, saveOAuthResult, getRefreshToken), newTask: (name, data) => 
        {
          return new Promise((resolve, reject) => 
          {
            const packet  = transport.newPacket({}, (ret) => ret?.error?reject(ret.error):resolve(ret), `_req-${cuid()}`);
    
            packet.method('connector.task.new');
            packet.args
            ({ 
              name,
              a: data
            });
    
            transport.send(packet);
          });
        }, updateTask: (id, data) => 
        {
          return new Promise((resolve, reject) => 
          {
            const packet  = transport.newPacket({}, (ret) => ret?.error?reject(ret.error):resolve(ret), `_req-${cuid()}`);
    
            packet.method('connector.task.update');
            packet.args
            ({ 
              id,
              a: data
            });
    
            transport.send(packet);
          });
        }})
      }
    }, onMessage: async (packet, transport) => 
    {
      try
      {
        const ret = await processPacket(packet);
        if (ret) reply(ret, packet, transport);
      } catch(e) {
        console.log(e);
        handlePacketError(packet, e, transport)
      }
    }});

    const term      = async () =>
    {
      await server.leaving();
      
      await new Promise((resolve) => 
      {
        setTimeout(async () => 
        {
          await server.close();
          resolve()
        }, 10000);
      });
      
      process.exit(0);
    };
  
    process.on('uncaughtException', (e) =>
    {
      console.log(e);
    });

    process.on('unhandledRejection', (e) => 
    {
      console.log(e);
    });
  
    process.on('SIGTERM', term);
    process.on('SIGINT', term);
  
    await server.start();
  }
}

module.exports = {Connector}






