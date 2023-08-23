// The deployment name you chose when you deployed the model.
const mapper = {
  'gpt-3.5-turbo': {
    'proxy': PROXY_GPT35,
    'resource': RESOURCE_NAME_GPT35,
    'deploy': DEPLOY_NAME_GPT35
  },
  'gpt-3.5-turbo-16k': {
    'proxy': PROXY_GPT35,
    'resource': RESOURCE_NAME_GPT35,
    'deploy': DEPLOY_NAME_GPT35_16K
  },
  'gpt-4': {
    'proxy': PROXY_GPT4,
    'resource': RESOURCE_NAME_GPT4,
    'deploy': DEPLOY_NAME_GPT4
  },
  'gpt-4-32k': {
    'proxy': PROXY_GPT4,
    'resource': RESOURCE_NAME_GPT4,
    'deploy': DEPLOY_NAME_GPT4_32K
  }
};

const apiVersion="2023-05-15"

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  let body;
  if (request.method === 'POST') {
    body = await request.json();
  }
  const modelName = body?.model;  
  const modelInfo = mapper[modelName] || '' 

  if (modelInfo === '') {
    return new Response('Missing model mapper', {
        status: 403
    });
  }
  
  // Mix: for OpenAI
  if (modelInfo['proxy'] == 'openai') {
    handleOpenAIRequest(request)
  }

  // Mix: for Azure
  // https://github.com/haibbo/cf-openai-azure-proxy/blob/main/cf-openai-azure-proxy.js
  if (request.method === 'OPTIONS') {
    return handleOPTIONS(request)
  }

  if (url.pathname.startsWith("//")) {
    url.pathname = url.pathname.replace('/',"")
  }
  if (url.pathname === '/v1/chat/completions') {
    var path="chat/completions"
  } else if (url.pathname === '/v1/completions') {
    var path="completions"
  } else if (url.pathname === '/v1/models') {
    return handleModels(request)
  } else {
    return new Response('404 Not Found', { status: 404 })
  }

  const resourceName = modelInfo['resource'];
  const deployName = modelInfo['deploy'];
  const fetchAPI = `https://${resourceName}.openai.azure.com/openai/deployments/${deployName}/${path}?api-version=${apiVersion}`

  const authKey = request.headers.get('Authorization');
  if (!authKey) {
    return new Response("Not allowed", {
      status: 403
    });
  }

  const payload = {
    method: request.method,
    headers: {
      "Content-Type": "application/json",
      "api-key": authKey.replace('Bearer ', ''),
    },
    body: typeof body === 'object' ? JSON.stringify(body) : '{}',
  };

  let response = await fetch(fetchAPI, payload);
  response = new Response(response.body, response);
  response.headers.set("Access-Control-Allow-Origin", "*");

  if (body?.stream != true){
    return response
  } 

  let { readable, writable } = new TransformStream()
  stream(response.body, writable);
  return new Response(readable, response);

}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// support printer mode and add newline
async function stream(readable, writable) {
  const reader = readable.getReader();
  const writer = writable.getWriter();

  // const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
// let decodedValue = decoder.decode(value);
  const newline = "\n";
  const delimiter = "\n\n"
  const encodedNewline = encoder.encode(newline);

  let buffer = "";
  while (true) {
    let { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true }); // stream: true is important here,fix the bug of incomplete line
    let lines = buffer.split(delimiter);

    // Loop through all but the last line, which may be incomplete.
    for (let i = 0; i < lines.length - 1; i++) {
      await writer.write(encoder.encode(lines[i] + delimiter));
      await sleep(20);
    }

    buffer = lines[lines.length - 1];
  }

  if (buffer) {
    await writer.write(encoder.encode(buffer));
  }
  await writer.write(encodedNewline)
  await writer.close();
}

async function handleModels(request) {
  const data = {
    "object": "list",
    "data": []  
  };

  for (let key in mapper) {
    data.data.push({
      "id": key,
      "object": "model",
      "created": 1677610602,
      "owned_by": "openai",
      "permission": [{
        "id": "modelperm-M56FXnG1AsIr3SXq8BYPvXJA",
        "object": "model_permission",
        "created": 1679602088,
        "allow_create_engine": false,
        "allow_sampling": true,
        "allow_logprobs": true,
        "allow_search_indices": false,
        "allow_view": true,
        "allow_fine_tuning": false,
        "organization": "*",
        "group": null,
        "is_blocking": false
      }],
      "root": key,
      "parent": null
    });  
  }

  const json = JSON.stringify(data, null, 2);
  return new Response(json, {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleOPTIONS(request) {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Allow-Headers': '*'
      }
    })
}

// OpenAI
// https://github.com/barretlee/cloudflare-proxy/blob/main/cloudflare-worker.js
async function handleOpenAIRequest(request) {
  const url = new URL(request.url);
  const fetchAPI = request.url.replace(url.host, 'api.openai.com');
  
  // 部分代理工具，请求由浏览器发起，跨域请求时会先发送一个 preflight 进行检查，也就是 OPTIONS 请求
  // 需要响应该请求，否则后续的 POST 会失败
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const authKey = request.headers.get('Authorization');
  if (!authKey) return new Response("Not allowed", { status: 403 });

  let contentType = request.headers.get('Content-Type')
  if (contentType && contentType.startsWith("multipart/form-data")) {
    let newRequest = new Request(fetchAPI, request);
    return await fetch(newRequest);
  }

  let body;
  if (request.method === 'POST') body = await request.json();

  const payload = {
    method: request.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: authKey,
    },
    body: typeof body === 'object' ? JSON.stringify(body) : '{}',
  };
  // 在 Cloudflare 中，HEAD 和 GET 请求带 body 会报错
  if (['HEAD', 'GET'].includes(request.method)) delete payload.body;

  // 入参中如果包含了 stream=true，则表现形式为流式输出
  const response = await fetch(fetchAPI, payload);
  if (body && body.stream !== true) {
    const results = await response.json();
    return new Response(JSON.stringify(results), {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } else {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}
