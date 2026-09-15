'use strict'

//-------------

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser')
const app = express();
const fs = require('fs');

const axios = require('axios');

//-- CORS - update as needed for your environment -
app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    // res.header("Access-Control-Allow-Methods", "OPTIONS,GET,POST,PUT,DELETE");
    res.header("Access-Control-Allow-Methods", "GET,POST");
    res.header("Access-Control-Allow-Headers", "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With");
    next();
});

//--

app.use(bodyParser.json());

//------------------------------

const appId = process.env.APP_ID;
const serviceNumber = process.env.SERVICE_NUMBER;
const vccNumber = process.env.VCC_NUMBER;
const vccRegion = process.env.VCC_REGION;
const apiRegion = process.env.API_REGION;
const dc = apiRegion.substring(4, 8);

// ------------------

console.log("Service phone number:", serviceNumber);

console.log("VCC number:", vccNumber);
console.log("VCC region:", vccRegion);

//-------------------

const { Auth } = require('@vonage/auth');

const credentials = new Auth({
  apiKey: process.env.API_KEY,
  apiSecret: process.env.API_SECRET,
  applicationId: appId,
  privateKey: './.private.key'
});

const options = {
  apiHost: apiRegion
};

const { Vonage } = require('@vonage/server-sdk');

// const vonage = new Vonage(credentials, options);
const vonage = new Vonage(credentials);

const privateKey = fs.readFileSync('./.private.key');

const { tokenGenerate } = require('@vonage/jwt');

//-- List of allowable client SDK (WebRTC client) users --

const clientList = process.env.CLIENT_SDK_USERS.toLowerCase().split(/\s*,+\s*/);

let clients = new Set();

for (let client in clientList){
  clients.add(clientList[client]);
};

console.log('List of allowable clients:', clients);

// create IVR voice prompts for PSTN incoming calls, the following example assumes
// you did specify more than 1 and up to 9 allowable client SDK user names (in .env file)

// let ivrPrompt = "Welcome to our company. ";

// let index = 0;
// for (let client of clients) {
//   index++;
//   ivrPrompt = ivrPrompt + `To speak to ${client}, press ${index}. `;
// };

const clientsArray = Array.from(clients);

// no IVR for direct in-app to in-app calls (WebRTC client to WebRTC client)

//==========================================================

app.get('/answer', (req, res) => {

  const hostName = req.hostname;

  let nccoResponse;

  if (req.query.from_user) {  // is it a call from a client SDK (WebRTC client)?

    if (/^\d+$/.test(req.query.to)) { // is the "to" field value all digits? if yes, call that PSTN number

      if (req.query.to == serviceNumber) {  // a client SDK calling this number will get bridged with the VCC number

        nccoResponse = [
          { // this "talk" action may be skipped and just let VCC say initial voice prompts
            "action": "talk",
            "text": "Connecting your call, please wait.",
            "language": "en-US",
            "style": 11
          },
          {
            "action": "conversation",
            "name": `conf_${req.query.uuid}`, // create a unique named conference
            "startOnEnter": true,
            "endOnExit": true
          }
        ];

      } else {  // call from a client SDK to an external phone number

        nccoResponse = [
          {
            "action": "talk",
            "text": "Connecting your call, please wait",
            "language": "en-US",
            "style": 11
          },        
          {
            "action": "connect",
            "eventUrl": [`https://${hostName}/inappevent`], 
            "timeout": 45,
            "from": serviceNumber,
            "endpoint": [
              {
                "type": "phone",
                "number": req.query.to
              }
            ]
          }
        ];

      }  

    } else {  // call from a client SDK to another client SDK

      const calledUser = req.query.to.toLowerCase();

      if (calledUser == 'support') {  // this client SDK call will be bridged to the call to VCC number

        nccoResponse = [
          { // this "talk" action may be skipped and just let VCC say initial voice prompts
            "action": "talk",
            "text": "Connecting your call, please wait.",
            "language": "en-US",
            "style": 11
          },
          {
            "action": "conversation",
            "name": `conf_${req.query.uuid}`, // create a unique named conference
            "startOnEnter": true,
            "endOnExit": true
          }
        ];

      } else {  // calling another client SDK user

        nccoResponse = [
          {
            "action": "talk",
            "text": "Connecting your call, please wait",
            "language": "en-US",
            "style": 11
          },
          { 
            "action": "connect", 
            "from": req.query.from,
            "endpoint": [ 
              { "type": "app", 
                "user": calledUser
              }
            ],
            "timeout": 45,
            "eventUrl": [`https://${hostName}/inappevent`], 
            "eventMethod": "POST" 
          }
        ];

      }  
        
    }  

  } else {

    // select either of the two following call processing

    // this incoming call from a non client SDK (WebRTC client), i.e. from PSTN ot from SIP will get rejected with a voice announcement
    nccoResponse = [
      { 
        "action": "talk",
        "text": "This number does not accept incoming calls. Good bye!",
        "language": "en-US",
        "style": 11
      }
    ];

    // this incoming call from a non client SDK (WebRTC client), i.e. from PSTN ot from SIP will get bridged with the call to VCC number
    // nccoResponse = [
    //   {  // this "talk" action may be skipped and just let VCC say initial voice prompts
    //     "action": "talk",
    //     "text": "Connecting your call, please wait.",
    //     "language": "en-US",
    //     "style": 11
    //   },
    //   {
    //     "action": "conversation",
    //     "name": `conf_${req.query.uuid}`, // create a unique named conference
    //     "startOnEnter": true,or
    //     "endOnExit": true
    //   }
    // ];

  };  

  res.status(200).json(nccoResponse);

});

//--------

app.post('/event', (req, res) => {

  const uuid = req.body.uuid;
  const hostName = req.hostname;

  if (req.body.type == 'transfer') {  // this is when the incoming call is effectively connected to the named conference

    //-- Create outbound call to VCC --

    // console.log('>>> SIP URI:', `sip:${vccNumber}@${vccRegion}`);

    vonage.voice.createOutboundCall({
      to: [{
        type: 'sip',
        uri: `sip:${vccNumber}@${vccRegion}`,
        standard_headers: {
          "User-to-User": req.body.from_user // pass the caller info
        }
      }],
      from: {
       type: 'phone',
       number: serviceNumber
      },
      // answer_url: ['https://' + hostName + '/answer_vcc?original_uuid=' + uuid],
      // answer_method: 'GET',
      ncco: [
        {
        "action": "conversation",
        "name": `conf_${uuid}`, // use the same unique named conference when peer incoming call was answered
        "startOnEnter": true,
        "endOnExit": true
        }
      ],
      event_url: ['https://' + hostName + '/event_vcc?original_uuid=' + uuid],
      event_method: 'POST'
      })
      .then(res => console.log(">>> Outbound VCC call status:", res))
      .catch(err => console.error(">>> Outbound VCC call error:", err))

  }

  res.status(200).send('Ok');
  
});

//--------

app.post('/event_vcc', (req, res) => {

  res.status(200).send('Ok');
  
});

//--------

app.post('/inappevent', (req, res) => {

  res.status(200).send('Ok');
  
});

//--------

// app.post('/rtc', (req, res) => {

//   res.status(200).send('Ok');
  
// });

//=== Services for the WebRTC client (Vonage client SDK) ===============

app.post('/login', async (req, res) => {

    const user = req.body.user; // web page should have already made the name to lower case

    // check if user is in the list of allowable users
    if (!clients.has(user)) {
      return res.status(401).json({ name: user, message: ">>> Unknown user" });
    }

    console.log("Creating user: " + user);
    // either get or create this user (if not yet existing)
    const userId = await getUser(user);
    
    console.log("Generating JWT for user: " + user);
    const jwt = await generateJWT(user);
        
    return res.status(200).json({ name: user, userId: userId, token: jwt, dc: dc, phone: serviceNumber });
})

//--------

async function getUser(name) {
    
  const accessToken = tokenGenerate(appId, privateKey, {});
  
  return new Promise(async (resolve, reject) => {
    
    let results;
    
    try {
      results = await axios.get('https://api.nexmo.com/v0.3/users?name=' + name,
        {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + accessToken
            }
        });

      //-- debug
      // console.log(">>> results.data:", results.data);
      // console.log("User Retrieval results: ", results.data._embedded.users[0].id);
      
      // If user already exists, just use it!
      resolve(results.data._embedded.users[0].id);
      return;
    } 
    catch (err) {

        console.log(">>> err.response:", err.response);
        // console.log("User retrieval error: ", err.response.data)
    }
    
    // Here - user does NOT exist, create it
    try {
        let body = {
            name: name,
            display_name: name
        }
        results = await axios.post('https://api.nexmo.com/v0.3/users', body,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + accessToken
                }
            });
        console.log("User creation results: ", results.data);
        
        // New user created, pass back the id
        resolve(results.data.id);
        
        return;
    } 
    catch (err) {
        console.log(">>> User creation error:", err);
        console.log("User creation error: ", err.response?.statusText)
        
        resolve(null);
    }
  })

}

//--------

app.post('/logout', async (req, res) => {
    
    let user = req.body.user;
    let session = req.body.session;
    
    // console.log("Deleting session: " + session);
    await delSession(session);

    return res.status(200).end();
})

//--------

async function generateJWT(sub) {
    
    // Generate a JWT with the appropriate ACL
    let jwtExpiration = Math.round(new Date().getTime() / 1000) + 2592000; //30 days
    
    const aclPaths = {
        "paths": {
            "/*/users/**": {},
            "/*/conversations/**": {},
            "/*/sessions/**": {},
            "/*/devices/**": {},
            "/*/image/**": {},
            "/*/media/**": {},
            "/*/applications/**": {},
            "/*/push/**": {},
            "/*/knocking/**": {},
            "/*/legs/**": {}
        }
    }
    let claims = {
        exp: jwtExpiration,
        //ttl: 86400,
        acl: aclPaths,
    }
    
    // ONLY Client JWTs use a "sub", so don't add one if it is already passed in
    if (sub != null) {
        claims.sub = sub
    }
    
    //-- debug
    // console.log(appId, privateKey, claims);
    
    const jwt = tokenGenerate(appId, privateKey, claims)
    
    // debug
    // console.log("Jwt: ", jwt)
    
    return (jwt);
}

//--------

async function delSession(session) {

  // to do, fix the issue where it tries to delete again past deleted sessions

  const accessToken = tokenGenerate(appId, privateKey, {});
  
  return new Promise(async (resolve, reject) => {

    let results;

    try {
      results = await axios.delete('https://api.nexmo.com/v0.3/sessions/' + session,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + accessToken
          }
        });
      // console.log("User session deletion results: ", results.data);
      resolve(results.data);
      return;
    } 
    catch (err) {
      // console.log("User session deletion error: ", err)
    }
  })

}

//--------------- for VCR ----------------

app.get('/_/health', async (req, res) => {
   
  res.status(200).send('Ok');

});

//========== Static HTTP server ===========

app.use ('/', express.static(__dirname + '/public')); // static web server

//=========================================

const port = process.env.NERU_APP_PORT || process.env.PORT || 8000;

app.listen(port, () => console.log(`Application listening on port ${port}`));

//------------
