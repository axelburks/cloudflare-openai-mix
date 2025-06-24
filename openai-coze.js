addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const COZE_CHAT_URL = "https://api.coze.com/v3/chat";
const COZE_CHAT_RETRIEVE_URL = "https://api.coze.com/v3/chat/retrieve";
const COZE_CHAT_MSG_URL = "https://api.coze.com/v3/chat/message/list";
const COZE_UPLOAD_URL = "https://api.coze.com/v1/files/upload";

// @ts-ignore
const botConfig = JSON.parse(BOT_CONFIG);
const botDefault = botConfig[botConfig['default']]['bot_id'];
// @ts-ignore
const r2Config = JSON.parse(R2_CONFIG);
const r2UploadUrl = r2Config.upload_url || ''
const r2AuthKey = r2Config.auth_key || ''

let authKey;
let cozeToken;

/**
 * @param {Request} request
 */
async function handleRequest(request) {
  if (request.method === "OPTIONS") return handleOptionsRequest(request);

  authKey = request.headers.get('Authorization');
  if (!authKey) return new Response("Not allowed", { status: 403 });
  cozeToken = await getCozeToken()

  const urlObj = new URL(request.url);
  const urlPath = urlObj.pathname;

  if (request.method === "GET") {
    if (request.url.indexOf('/v1/models') > -1) {
      if (urlPath === '/v1/models') return handleModels();
      let modelMatch = urlPath.match(/\/v1\/models\/(.+)/)
      if (modelMatch) {
        return handleModels(modelMatch[1]);
      } else {
        return handleModels();
      }
    } else {
      return new Response(`Not supported ${request.method} path: ${urlPath}`, { status: 500 })
    }
  }

  if (request.method === "POST") {
    if (urlPath === '/v1/images/generations') return await handleImageRequest(request);
    return await handleMessageRequest(request)
  } else {
    return new Response(`Not supported method: ${request.method}`, { status: 500 });
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Credentials": "true",
};

/**
 * @param {Request} request
 */
async function handleMessageRequest(request) {
  const requestBody = await request.json();
  const messages = requestBody.messages;
  const streamON = requestBody.stream;
  const model = requestBody.model;

  const botID = model && (model in botConfig) ? botConfig[model]['bot_id'] : botDefault;
  
  let chatHistory = [];
  let systemPrompt = "";
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const role = message.role;
    let content = message.content;
    let contentType = "text";
    if (role == "system") {
      systemPrompt = content;
    } else {
      if (Array.isArray(content)) {
        contentType = "object_string"
        for (let j = 0; j < content.length; j++) {
          if (content[j]["type"] == "image_url") {
            let itemFileUrl = content[j]["image_url"]["url"];
            if (itemFileUrl.startsWith('data:image')){
              let uploadResult = await uploadFile2Coze(itemFileUrl);
              if (uploadResult.success) {
                content[j] = {
                  "type": "image",
                  "file_id": uploadResult.id
                }
              } else {
                uploadResult = await uploadFile2R2(itemFileUrl);
                if (uploadResult.success) {
                  content[j] = {
                    "type": "image",
                    "file_url": uploadResult.uploadUrl
                  }
                } else {
                  return new Response(`Error: upload file failed`, { status: 500 });
                }
              }
            }
          }
          if (content[j]["type"] == "text" && i == messages.length - 1) {
            [systemPrompt, content[j]["text"]] = formatSystemQuery(systemPrompt, content[j]["text"])
          }
        }
        content = JSON.stringify(content)
      } else if (i == messages.length - 1) {
        [systemPrompt, content] = formatSystemQuery(systemPrompt, content)
      }

      // transfer coze type in content to real coze type
      let contentPure = content;
      let m;
      const regex = /```json\\n({\\"type\\":\\"[\w_]+?\\",\\"content\\":.*?)\\n```\\n/gm;
      while ((m = regex.exec(content)) !== null) {
        if (m.index === regex.lastIndex) {
            regex.lastIndex++;
        }
        try {
          const coze_type_json = JSON.parse(m[1].replace(/\\"/g, '"'));
          chatHistory.push({
            role: role,
            type: coze_type_json.type,
            content: JSON.stringify(coze_type_json.content),
            content_type: contentType
          });
          contentPure = contentPure.replace(m[0], '');
        } catch {
          console.log(m)
        }
      }

      chatHistory.push({
        role: role,
        content: contentPure,
        content_type: contentType
      })
    }
  }  
  
  const cozeRequestBody = {
    bot_id: botID,
    user_id: "29032201862555",
    // query: queryString,
    stream: streamON,
    additional_messages: chatHistory,
    auto_save_history: streamON ? false : true,
    custom_variables: {
      "system_prompt": systemPrompt
    }
  };

  const cozeRequestHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${cozeToken}`
  }
  
  const response = await fetch(COZE_CHAT_URL, {
    method: "POST",
    headers: cozeRequestHeaders,
    body: JSON.stringify(cozeRequestBody)
  });
  
  if (streamON) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let reader = response.body.getReader();
    let contentBuffer = "";
    let streamIncludeUsage = requestBody.stream_options?.include_usage;
    let openaiUsageData = null;

    return new Response(new ReadableStream({
      async start(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          let chunk = decoder.decode(value);
          contentBuffer += chunk;

          while (contentBuffer.includes("\n\n")) {
            const newlineIndex = contentBuffer.indexOf("\n\n");
            const chunk_event_data = contentBuffer.slice(0, newlineIndex);
            contentBuffer = contentBuffer.slice(newlineIndex + 1);
            const lines = chunk_event_data.split('\n');
            let eventType;

            for (const line of lines) {
              if (line.startsWith('event:')) {
                eventType = line.slice('event:'.length).trim();
              } else if (line.startsWith('data:')) {
                try {
                  const data = JSON.parse(line.slice('data:'.length).trim());
                  let openaiFmtData;
                  if (eventType === 'conversation.message.delta') {
                    openaiFmtData = {
                      id: "chatcmpl-" + Math.random().toString(36).slice(2),
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      usage: null,
                      choices: [{
                        index: 0,
                        delta: {
                          content: data.content
                        },
                        finish_reason: null
                      }]
                    };
                    if (data.reasoning_content) openaiFmtData.choices[0].delta.reasoning_content = data.reasoning_content;
                  } else if (eventType === 'conversation.message.completed' && ['function_call'].includes(data.type)) {
                    openaiFmtData = {
                      id: "chatcmpl-" + Math.random().toString(36).slice(2),
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      usage: null,
                      choices: [{
                        index: 0,
                        delta: {
                          content: "```json\n" + `{"type":"${data.type}","content":${data.content}}` + "\n```\n"
                        },
                        finish_reason: "stop"
                      }]
                    };
                  } else if (eventType === 'conversation.chat.completed' && streamIncludeUsage) {
                    openaiUsageData = {
                      id: "chatcmpl-" + Math.random().toString(36).slice(2),
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      usage: {
                        completion_tokens: data.usage.output_count,
                        prompt_tokens: data.usage.input_count,
                        total_tokens: data.usage.token_count
                      },
                      choices: []
                    };
                  } else if (eventType === 'error') {
                    openaiFmtData = {
                      id: "chatcmpl-" + Math.random().toString(36).slice(2),
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      usage: null,
                      choices: [{
                        index: 0,
                        delta: {
                          content: data
                        },
                        finish_reason: "stop"
                      }]
                    };
                  }
                  if (openaiFmtData) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiFmtData)}\n\n`));
                  }
                } catch (error) {
                  console.error("Error for parsing json: ", error, "raw data:", line);
                }
              }
            }
          }
        }
        
        if (contentBuffer) {
          const restData = {
            id: "chatcmpl-" + Math.random().toString(36).slice(2),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            usage: null,
            choices: [{
              index: 0,
              delta: {
                content: contentBuffer
              },
              finish_reason: "stop"
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(restData)}\n\n`));
        }

        const doneData = {
          id: "chatcmpl-" + Math.random().toString(36).slice(2),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop"
          }]
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneData)}\n\n`));

        if (openaiUsageData) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiUsageData)}\n\n`));
        }

        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));

        controller.close();
      }
    }), {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" }
    });
  } else {
    // Non-Stream Response
    let openaiFmtData = {
      id: "chatcmpl-" + Math.random().toString(36).slice(2),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null
        },
        finish_reason: "stop"
      }],
      usage: {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "prompt_tokens_details": {
          "cached_tokens": 0,
          "audio_tokens": 0
        },
        "completion_tokens_details": {
          "reasoning_tokens": 0,
          "audio_tokens": 0,
          "accepted_prediction_tokens": 0,
          "rejected_prediction_tokens": 0
        }
      }
    };
    if (response.status !== 200) return response;
    const chat_info = await response.json();
    if (chat_info.code !== 0) {
      openaiFmtData.choices[0].message.content = JSON.stringify(chat_info)
      return new Response(JSON.stringify(openaiFmtData), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    let cozeChatData;
    const cozeChatRetrieveUrl = `${COZE_CHAT_RETRIEVE_URL}?conversation_id=${chat_info.data.conversation_id}&chat_id=${chat_info.data.id}`;
    const cozeChatMsgUrl = `${COZE_CHAT_MSG_URL}?conversation_id=${chat_info.data.conversation_id}&chat_id=${chat_info.data.id}`;

    let attempt = 0;
    let maxAttempts = 20;
    let interval = 1000; // 1 second
    while (attempt < maxAttempts) {
      attempt++;
      cozeChatData = await fetchData(cozeChatRetrieveUrl, 'GET', cozeRequestHeaders, null, {"code": 0});
      if (cozeChatData.success) {
        if (['completed'].includes(cozeChatData.body.data.status)) {
          let cozeMsgData = await fetchData(cozeChatMsgUrl, 'GET', cozeRequestHeaders, null, {"code": 0});
          if (cozeMsgData.success) {
            if (model === "dall-e-3") {
              const answerMessages = cozeMsgData.body.data.filter(message => ['tool_response'].includes(message.type));
              openaiFmtData.choices[0].message.content = JSON.parse(answerMessages[0].content)
            } else {
              const answerMessages = cozeMsgData.body.data.filter(message => ['answer', 'function_call'].includes(message.type));
              openaiFmtData.choices[0].message.content = answerMessages.map(message => message.content).join("\n");
              const reasonContent = answerMessages.map(message => message.reasoning_content).join("");
              if (reasonContent) openaiFmtData.choices[0].message.reasoning_content = reasonContent
              openaiFmtData.usage.prompt_tokens = cozeChatData.body.data.usage.input_count
              openaiFmtData.usage.completion_tokens = cozeChatData.body.data.usage.output_count
              openaiFmtData.usage.total_tokens = cozeChatData.body.data.usage.token_count
            }
          } else {
            openaiFmtData.choices[0].message.content = JSON.stringify(cozeMsgData)
          }
          return new Response(JSON.stringify(openaiFmtData), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } else if (['requires_action'].includes(cozeChatData.body.data.status)) {
          openaiFmtData.choices[0].message.tool_calls = cozeChatData.body.data.required_action.submit_tool_outputs.tool_calls.map(item => {
            return item
          });
          openaiFmtData.choices[0].finish_reason = "tool_calls";
          return new Response(JSON.stringify(openaiFmtData), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } else if (['failed'].includes(cozeChatData.body.data.status)) {
          openaiFmtData.choices[0].message.content = JSON.stringify(cozeChatData)
          return new Response(JSON.stringify(openaiFmtData), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      } else {
        openaiFmtData.choices[0].message.content = JSON.stringify(cozeChatData)
        return new Response(JSON.stringify(openaiFmtData), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      if (attempt >= 5) {
        interval = 2000; // 2 seconds
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    openaiFmtData.choices[0].message.content = JSON.stringify({
      "msg": `Retrieve cozeChatData timeout with attempt ${attempt}`,
      "data": cozeChatData
    })
    return new Response(JSON.stringify(openaiFmtData), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}

/**
 * @param {Request} request
 */
async function handleImageRequest(request) {
  const requestBody = await request.json();
  const model = requestBody.model;
  const prompt = requestBody.prompt;
  const size = requestBody.size;

  const ratio_map = {
    "1024x1024": 1,
    "1024x1792": 2,
    "1792x1024": 3
  };
  const ratio = ratio_map[size] || 1;

  const cozeDalle3Request = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify({
      "model": model,
      "messages": [
        {
          "role": "user",
          "content": `Use DALLE3 to generate image.\nratio: ${ratio}\nprompt: ${prompt}`
        }
      ],
      "stream": false
    })
  });
  const cozeDalle3Response = await handleMessageRequest(cozeDalle3Request);
  const cozeDalle3ResponseBody = await cozeDalle3Response.json()
  const cozeDalle3Data = cozeDalle3ResponseBody.choices[0].message.content
  const image_url = cozeDalle3Data.data_structural[0].image_ori.url
  const openaiFmtData = {
    "created": Math.floor(Date.now() / 1000),
    "data": [
      {
        "url": image_url
      }
    ]
  }
  return new Response(JSON.stringify(openaiFmtData), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

/**
 * @param {string} queryString
 * @param {string} systemPrompt
 */
function formatSystemQuery(systemPrompt, queryString) {
  // {{{xxxx<user_prompt>xxxx}}}: get it from systemPrompt, then replace <user_prompt> with queryString, then assign it to queryString, then del it from systemPrompt
  // [[[xxxxxxxx]]]: get it from systemPrompt, then replace <user_prompt> with queryString,  then assign it to systemPrompt, then del it from queryString
  if (systemPrompt) {
    if (/\{\{\{([\s\S]+)\}\}\}/.test(systemPrompt)) {
      queryString = systemPrompt.match(/\{\{\{([\s\S]+)\}\}\}/)[1].replaceAll("<user_prompt>", queryString);
      systemPrompt = systemPrompt.replace(/\{\{\{([\s\S]+)\}\}\}/, "");
    } else if (systemPrompt.includes("[[[<user_prompt>]]]")) {
      systemPrompt = systemPrompt.replaceAll("[[[<user_prompt>]]]", queryString);
      // coze will reponse null w/o queryString
      queryString = " ";
    }
  }
  return [systemPrompt, queryString];
}

/**
 * @param {string} base64Image
 */
async function uploadFile2Coze(base64Image) {
  const fileInfo = convertBase64Image2Byte(base64Image);
  const uploadUrl = COZE_UPLOAD_URL;
  const uploadHeaders = {
    'Authorization': `Bearer ${cozeToken}`
  }
  const formData = new FormData();
  formData.append('file', new Blob([fileInfo.byte]), `${fileInfo.name}.${fileInfo.ext}`);
  const uploadResult = await fetchData(uploadUrl, 'POST', uploadHeaders, formData);
  if (uploadResult.success) {
    uploadResult.file_name = uploadResult.body.data.file_name;
    uploadResult.id = uploadResult.body.data.id;
  }
  return uploadResult;
}

/**
 * @param {string} base64Image
 */
async function uploadFile2R2(base64Image) {
  let uploadResult;
  if (r2UploadUrl && r2AuthKey) {
    const fileInfo = convertBase64Image2Byte(base64Image);
    const uploadUrl = `${r2UploadUrl}/${fileInfo.name}.${fileInfo.ext}`;
    const uploadHeaders = {
      'X-API-Key': r2AuthKey,
      'overwrite': 'true'
    }
    uploadResult = await fetchData(uploadUrl, 'PUT', uploadHeaders, fileInfo.byte);
    if (uploadResult.success) uploadResult.uploadUrl = uploadUrl;
  } else {
    uploadResult = {
      "success": false,
      "msg": "Missing r2UploadUrl or r2AuthKey in env var: R2_CONFIG",
      "body": null
    }
  }
  return uploadResult;
}

/**
 * @param {string} model
 */
function handleModels(model = null) {
  let data;
  if (model) {
    data = {
      "id": model,
      "object": "model",
      "created": 1742469687,
      "owned_by": "openai"
    }
  } else {
    data = {
      "object": "list",
      "data": []  
    };
    for (let key in botConfig) {
      data.data.push({
        "id": key,
        "object": "model",
        "created": 1742469687,
        "owned_by": "openai"
      });
    }
  }
  const dataString = JSON.stringify(data, null, 2);
  return new Response(dataString, {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * @param {any} request
 */
function handleOptionsRequest(request) {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*'
    }
  })
}

/**
 * @param {string} base64Image
 */
function convertBase64Image2Byte(base64Image) {
  const mimeString = base64Image.split(',')[0].split(':')[1].split(';')[0];
  const fileExtension = mimeString.split('/')[1];
  // 生成随机文件名
  const randomFileName = `${Math.random().toString(36).substring(2, 15)}`;
  // 将 base64 图片转换为 Uint8Array
  const byteString = atob(base64Image.split(',')[1]);
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }
  const result = {
    "name": randomFileName,
    "ext": fileExtension,
    "byte": ia
  }
  return result;
}

async function fetchData(fetchUrl, fetchMethod, fetchHeaders = {}, fetchBody = null, checkKV = {}) {
  let result = {
    "success": false,
    "msg": "",
    "body": null
  }
  
  try {
    const fetchResponse = await fetch(fetchUrl, {
      method: fetchMethod,
      headers: fetchHeaders,
      body: fetchBody
    });
    const fetchResponseText = await fetchResponse.text();
    if (fetchResponse.status !== 200) {
      result.msg = `Error: status code ${fetchResponse.statusText}, ${fetchResponseText}`;
    } else {
      let fetchResponseJson;
      try {
        fetchResponseJson = JSON.parse(fetchResponseText);
      } catch (error) {
        fetchResponseJson = { text: fetchResponseText };
      }
      const isValid = Object.entries(checkKV).every(([key, value]) => fetchResponseJson[key] === value);
      if (isValid) {
        result.success = true;
        result.body = fetchResponseJson;
      } else {
        result.msg = `Error: checkKV failed, ${JSON.stringify(checkKV)}, ${fetchResponseText}`;
      }
    }
  } catch (error) {
    result.msg = `Error: ${JSON.stringify(error)}`;
  }
  return result;
}

// Base64 URL编码工具
function base64url(str) {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// 生成JWT令牌（基于Web Crypto）
async function generateJWT() {
  try {
    // 准备Header
    const header = {
      alg: "RS256",
      typ: "JWT",
      kid: COZE_SIGNING_PUBLIC_KEY
    };
    const encodedHeader = base64url(JSON.stringify(header));
    
    // 准备Payload
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now,
      exp: now + 600,
      jti: crypto.randomUUID(),
      aud: "api.coze.com",
      iss: '1165608857222'
    };
    const encodedPayload = base64url(JSON.stringify(payload));
    
    // 创建签名内容
    const data = `${encodedHeader}.${encodedPayload}`;
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    
    // 处理PEM格式私钥
    const pemContents = COZE_SIGNING_PRIVATE_KEY
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s+/g, '');
    const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
    
    // 导入私钥
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryDer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    
    // 生成签名
    const signature = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      privateKey,
      dataBuffer
    );
    
    // 格式化并返回JWT
    const signatureStr = String.fromCharCode(...new Uint8Array(signature));
    return `${data}.${base64url(signatureStr)}`;
  } catch (err) {
    console.error('[JWT Generation]', err);
    throw err;
  }
}

// 使用KV获取或刷新令牌
async function getCozeToken() {
  // 尝试从KV获取现有令牌
  const cachedToken = await KV_STORE_NAME.get('coze_token');
  
  // 如果存在且未过期，直接返回
  if (cachedToken) {
    return cachedToken;
  }

  const jwt = await generateJWT();
  
  // 请求新令牌
  const response = await fetch("https://api.coze.com/api/permission/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      duration_seconds: 86399,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer"
    })
  });
  
  if (!response.ok) {
    throw new Error(`API responded with ${response.status}`);
  }
  
  const result = await response.json();
  const token = result.access_token;
  const expiresIn = result.expires_in;
  
  // 在KV存储令牌（使用expirationTtl自动过期）
  await KV_STORE_NAME.put('coze_token', token, {
    expirationTtl: expiresIn - 600 // 提前600秒过期
  });
  
  return token;
}
