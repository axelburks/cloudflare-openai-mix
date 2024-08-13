const FOLLOW_UP_ENABLED = false; // 将此值设置为 true 或 false 以控制是否输出 follow_up 内容

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const encoder = new TextEncoder();

const API_URL = "https://api.coze.com/open_api/v2/chat";

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return handleOptionsRequest(request);
  }

  if (request.method !== "POST") {
    return new Response("OK", { status: 200 });
  }

  const authKey = request.headers.get('Authorization');
  if (!authKey) return new Response("Not allowed", { status: 403 });

  const requestBody = await request.json();
  const messages = requestBody.messages;
  const isStream = requestBody.stream;
  const model = requestBody.model;

  const default_bot_id = BOT_ID || "";
  const botConfig = BOT_CONFIG ? JSON.parse(BOT_CONFIG) : {};
  const bot_id = model && botConfig[model] ? botConfig[model] : default_bot_id;
  const chatHistory = [];
  let systemPrompt = "";
  for (let i = 0; i < messages.length - 1; i++) {
    const message = messages[i];
    const role = message.role;
    var content = message.content;
    if (role == "system") {
      systemPrompt = content;
    } else {
      if (Array.isArray(content)) {
        content = JSON.stringify(content)
      }
      chatHistory.push({
        role: role,
        content: content,
        content_type: "text"
      });
    }
  }
  var queryString = messages[messages.length - 1].content;
  if (Array.isArray(queryString)) {
    queryString = JSON.stringify(queryString)
  }

  // {{{xxxx<user_prompt>xxxx}}}: replace <user_prompt> with queryString, then place it in queryString, then del from system prompt
  // [[[xxxxxxxx]]]: replace with queryString, then del from user prompt
  if (systemPrompt) {
    if (/\{\{\{([\s\S]+)\}\}\}/.test(systemPrompt)) {
      queryString = systemPrompt.match(/\{\{\{([\s\S]+)\}\}\}/)[1].replaceAll("<user_prompt>", queryString)
      systemPrompt = systemPrompt.replace(/\{\{\{([\s\S]+)\}\}\}/, "")
    } else if (systemPrompt.includes("[[[<user_prompt>]]]")) {
      systemPrompt = systemPrompt.replaceAll("[[[<user_prompt>]]]", queryString)
      // coze will reponse null if w/o queryString
      queryString = " "
    }
  }

  const newRequestBody = {
    // conversation_id: UA,
    bot_id: bot_id,
    user: "29032201862555",
    query: queryString,
    stream: isStream,
    chat_history: chatHistory,
    custom_variables: {
      "system_prompt": systemPrompt
    }
  };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": authKey
    },
    body: JSON.stringify(newRequestBody)
  });

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Credentials": "true",
  };

  if (isStream) {
    let decoder = new TextDecoder();
    let reader = response.body.getReader();
    let contentBuffer = "";
    let followUps = [];

    return new Response(new ReadableStream({
      async start(controller) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          let chunk = decoder.decode(value);
          contentBuffer += chunk;

          while (contentBuffer.includes("\n")) {
            const newlineIndex = contentBuffer.indexOf("\n");
            const line = contentBuffer.slice(0, newlineIndex);
            contentBuffer = contentBuffer.slice(newlineIndex + 1);

            if (line.startsWith("data:")) {
              try {
                const data = JSON.parse(line.slice(5));
                if (data.event === "message") {
                  const message = data.message;
                  if (message.type === "follow_up" && FOLLOW_UP_ENABLED) {
                    followUps.push(message.content);
                  } else if (message.type !== "verbose" && message.type !== "follow_up" && message.type !== "tool_response") {
                    const formattedData = {
                      id: "chatcmpl-" + Math.random().toString(36).slice(2),
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      choices: [{
                        index: 0,
                        delta: {
                          content: message.content
                        },
                        finish_reason: data.is_finish ? "stop" : null
                      }]
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(formattedData)}\n\n`));
                  }
                }
              } catch (error) {
                console.error("解析JSON时出错:", error, "原始数据:", line);
              }
            }
          }
        }

        if (FOLLOW_UP_ENABLED && followUps.length > 0) {
          const followUpText = "\n----follow_up----\n" + followUps.join("\n");
          const followUpData = {
            id: "chatcmpl-" + Math.random().toString(36).slice(2),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: {
                content: followUpText
              },
              finish_reason: "stop"
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(followUpData)}\n\n`));
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
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));

        controller.close();
      }
    }), {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" }
    });
  } else {
    const responseText = await response.text();
    const data = JSON.parse(responseText);
    
    const answerMessages = data.messages.filter(message => message.type !== "verbose" && message.type !== "follow_up" && message.type !== "tool_response");
    const followUpMessages = FOLLOW_UP_ENABLED ? data.messages.filter(message => message.type === "follow_up") : [];
    
    const formattedData = {
      id: "chatcmpl-" + Math.random().toString(36).slice(2),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: answerMessages.map(message => message.content).join("") +
            (FOLLOW_UP_ENABLED && followUpMessages.length > 0 ? "\n----follow_up----\n" + followUpMessages.map(message => message.content).join("\n") : "")
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: JSON.stringify(newRequestBody).length,
        completion_tokens: answerMessages.reduce((sum, message) => sum + message.content.length, 0) +
          (FOLLOW_UP_ENABLED && followUpMessages.length > 0 ? followUpMessages.reduce((sum, message) => sum + message.content.length, 0) + 20 : 0),
        total_tokens: JSON.stringify(newRequestBody).length +
          answerMessages.reduce((sum, message) => sum + message.content.length, 0) +
          (FOLLOW_UP_ENABLED && followUpMessages.length > 0 ? followUpMessages.reduce((sum, message) => sum + message.content.length, 0) + 20 : 0)
      }
    };
    return new Response(JSON.stringify(formattedData), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}

function handleOptionsRequest(request) {
  // const headers = {
  //   "Access-Control-Allow-Origin": "*",
  //   "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  //   "Access-Control-Allow-Headers": "*",
  //   "Access-Control-Allow-Credentials": "true",
  //   "Access-Control-Max-Age": "43200",
  // };

  // return new Response(null, {
  //   status: 204,
  //   headers: headers,
  // });
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*'
    }
  })
}
