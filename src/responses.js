import { Readable } from "node:stream";

export function responsesRequestToChat(body = {}, previousMessages = []) {
  const messages = [...previousMessages];
  messages.push(...instructionsToMessages(body.instructions));
  messages.push(...inputToMessages(body.input));

  const chat = {
    model: body.model,
    messages,
    stream: Boolean(body.stream)
  };

  copyIfPresent(body, chat, "temperature");
  copyIfPresent(body, chat, "top_p");
  copyIfPresent(body, chat, "metadata");
  copyIfPresent(body, chat, "tinygateway");

  if (body.max_output_tokens !== undefined) {
    chat.max_tokens = body.max_output_tokens;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chat.tools = body.tools.map(responsesToolToChatTool).filter(Boolean);
  }
  if (body.tool_choice !== undefined) {
    chat.tool_choice = responsesToolChoiceToChatToolChoice(body.tool_choice);
  }
  if (body.parallel_tool_calls !== undefined) {
    chat.parallel_tool_calls = body.parallel_tool_calls;
  }

  return chat;
}

export function chatResponseToResponses({ body = {}, request = {}, responseId = makeResponseId(), createdAt = nowSeconds() }) {
  const choice = Array.isArray(body.choices) ? body.choices[0] || {} : {};
  const message = choice.message || {};
  const text = contentToText(message.content);
  const output = [];

  if (text || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    output.push(messageOutputItem({ text }));
  }
  for (const call of message.tool_calls || []) {
    output.push(toolCallOutputItem(call));
  }

  const status = choice.finish_reason === "length" ? "incomplete" : "completed";
  return compactObject({
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    completed_at: status === "completed" ? nowSeconds() : undefined,
    model: request.model,
    output,
    output_text: text,
    usage: responsesUsage(body.usage)
  });
}

export async function sendResponsesStream({ res, upstream, request }) {
  const responseId = makeResponseId();
  const createdAt = nowSeconds();
  const messageId = makeMessageId();
  let sequence = 0;
  let text = "";
  let textStarted = false;
  const toolCalls = new Map();

  res.writeHead(upstream.status, {
    ...upstream.headers,
    "content-type": "text/event-stream"
  });

  const responseBase = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model: request.model,
    output: []
  };
  writeSse(res, "response.created", { ...responseBase, type: "response.created", sequence_number: sequence++ });

  for await (const event of parseChatCompletionStream(upstream.stream)) {
    if (event === "[DONE]") {
      break;
    }
    const choice = Array.isArray(event.choices) ? event.choices[0] || {} : {};
    const delta = choice.delta || {};
    if (delta.content) {
      if (!textStarted) {
        textStarted = true;
        writeSse(res, "response.output_item.added", {
          type: "response.output_item.added",
          sequence_number: sequence++,
          output_index: 0,
          item: messageOutputItem({ id: messageId, text: "", status: "in_progress" })
        });
        writeSse(res, "response.content_part.added", {
          type: "response.content_part.added",
          sequence_number: sequence++,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] }
        });
      }
      text += delta.content;
      writeSse(res, "response.output_text.delta", {
        type: "response.output_text.delta",
        sequence_number: sequence++,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: delta.content
      });
    }
    collectToolCallDeltas(toolCalls, delta.tool_calls);
  }

  const output = [];
  if (textStarted || toolCalls.size === 0) {
    const messageItem = messageOutputItem({ id: messageId, text });
    output.push(messageItem);
    writeSse(res, "response.output_text.done", {
      type: "response.output_text.done",
      sequence_number: sequence++,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text
    });
    writeSse(res, "response.content_part.done", {
      type: "response.content_part.done",
      sequence_number: sequence++,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] }
    });
    writeSse(res, "response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: sequence++,
      output_index: 0,
      item: messageItem
    });
  }

  for (const call of toolCalls.values()) {
    const item = toolCallOutputItem(call);
    output.push(item);
    writeSse(res, "response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: sequence++,
      output_index: output.length - 1,
      item
    });
    writeSse(res, "response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: sequence++,
      output_index: output.length - 1,
      item
    });
  }

  writeSse(res, "response.completed", {
    ...responseBase,
    type: "response.completed",
    sequence_number: sequence++,
    status: "completed",
    completed_at: nowSeconds(),
    output,
    output_text: text
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

export function rememberResponse(responseStore, responseId, messages, responseBody) {
  if (!responseStore || !responseId) {
    return;
  }
  const nextMessages = [...messages, ...responsesOutputToMessages(responseBody.output || [])];
  responseStore.set(responseId, nextMessages);
}

export function previousMessagesFor(responseStore, responseId) {
  if (!responseStore || !responseId) {
    return [];
  }
  return structuredClone(responseStore.get(responseId) || []);
}

function instructionsToMessages(instructions) {
  if (!instructions) {
    return [];
  }
  if (typeof instructions === "string") {
    return [{ role: "system", content: instructions }];
  }
  return inputToMessages(Array.isArray(instructions) ? instructions : [instructions]).map((message) => ({
    ...message,
    role: message.role === "user" ? "system" : message.role
  }));
}

function inputToMessages(input) {
  if (!input) {
    return [];
  }
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) {
    return [inputItemToMessage(input)].filter(Boolean);
  }
  return input.map(inputItemToMessage).filter(Boolean);
}

function inputItemToMessage(item) {
  if (typeof item === "string") {
    return { role: "user", content: item };
  }
  if (!item || typeof item !== "object") {
    return null;
  }
  if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
    return {
      role: "tool",
      tool_call_id: item.call_id || item.id,
      content: outputToString(item.output)
    };
  }
  if (item.type === "message" || item.role) {
    return {
      role: normalizeRole(item.role || "user"),
      content: responsesContentToChatContent(item.content)
    };
  }
  if (item.type === "input_text") {
    return { role: "user", content: item.text || "" };
  }
  if (item.type === "output_text") {
    return { role: "assistant", content: item.text || "" };
  }
  return { role: "user", content: responsesContentToChatContent(item.content || item.text || item.input || item) };
}

function responsesContentToChatContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return outputToString(content);
  }

  const parts = content.map((part) => {
    if (typeof part === "string") {
      return { type: "text", text: part };
    }
    if (part?.type === "input_text" || part?.type === "output_text") {
      return { type: "text", text: part.text || "" };
    }
    if (part?.type === "input_image" && part.image_url) {
      return { type: "image_url", image_url: { url: part.image_url, detail: part.detail || "auto" } };
    }
    return { type: "text", text: outputToString(part) };
  });

  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("\n");
  }
  return parts;
}

function responsesToolToChatTool(tool) {
  if (!tool || typeof tool !== "object") {
    return null;
  }
  if (tool.type === "function" || tool.function) {
    return {
      type: "function",
      function: compactObject({
        name: tool.name || tool.function?.name,
        description: tool.description || tool.function?.description,
        parameters: tool.parameters || tool.function?.parameters || { type: "object", properties: {} },
        strict: tool.strict ?? tool.function?.strict
      })
    };
  }
  if (tool.type === "custom") {
    return {
      type: "function",
      function: compactObject({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: {
            input: { type: "string" }
          },
          required: ["input"]
        }
      })
    };
  }
  return null;
}

function responsesToolChoiceToChatToolChoice(choice) {
  if (typeof choice === "string") {
    return choice;
  }
  if (choice?.type === "function" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return choice;
}

function responsesOutputToMessages(output) {
  const messages = [];
  for (const item of output) {
    if (item.type === "message") {
      messages.push({ role: "assistant", content: contentToText(item.content) });
    }
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id || item.id,
            type: "function",
            function: {
              name: item.name,
              arguments: item.arguments || "{}"
            }
          }
        ]
      });
    }
  }
  return messages;
}

function messageOutputItem({ id = makeMessageId(), text = "", status = "completed" } = {}) {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: []
      }
    ]
  };
}

function toolCallOutputItem(call) {
  const fn = call.function || {};
  return {
    id: call.id || call.call_id || makeCallId(),
    type: "function_call",
    status: "completed",
    call_id: call.id || call.call_id || makeCallId(),
    name: fn.name || call.name || "",
    arguments: fn.arguments || call.arguments || "{}"
  };
}

function collectToolCallDeltas(toolCalls, deltas = []) {
  for (const delta of deltas || []) {
    const key = delta.index ?? delta.id ?? toolCalls.size;
    const current = toolCalls.get(key) || { id: delta.id, type: "function", function: { name: "", arguments: "" } };
    current.id = current.id || delta.id;
    current.function.name += delta.function?.name || "";
    current.function.arguments += delta.function?.arguments || "";
    toolCalls.set(key, current);
  }
}

async function* parseChatCompletionStream(stream) {
  let buffer = "";
  for await (const chunk of Readable.fromWeb(stream)) {
    buffer += Buffer.from(chunk).toString("utf8");
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const dataLines = frame
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      for (const data of dataLines) {
        if (data === "[DONE]") {
          yield "[DONE]";
          return;
        }
        if (!data) {
          continue;
        }
        try {
          yield JSON.parse(data);
        } catch {
          // Ignore malformed upstream stream frames.
        }
      }
      separatorIndex = buffer.indexOf("\n\n");
    }
  }
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      return part?.text || "";
    })
    .filter(Boolean)
    .join("");
}

function responsesUsage(usage) {
  if (!usage) {
    return undefined;
  }
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    total_tokens: usage.total_tokens || 0
  };
}

function outputToString(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? "");
}

function normalizeRole(role) {
  if (role === "developer") {
    return "system";
  }
  return ["system", "user", "assistant", "tool"].includes(role) ? role : "user";
}

function copyIfPresent(source, target, key) {
  if (source[key] !== undefined) {
    target[key] = source[key];
  }
}

function compactObject(object) {
  const result = {};
  for (const [key, value] of Object.entries(object || {})) {
    if (value !== undefined && value !== null && value !== "") {
      result[key] = value;
    }
  }
  return result;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function makeResponseId() {
  return `resp_${crypto.randomUUID().replaceAll("-", "")}`;
}

function makeMessageId() {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

function makeCallId() {
  return `call_${crypto.randomUUID().replaceAll("-", "")}`;
}
