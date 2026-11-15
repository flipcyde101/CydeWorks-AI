export function diagnosticMessages(inventory) {
  const messages=Array.isArray(inventory?.diagnostics?.messages)
    ?inventory.diagnostics.messages.filter(message=>typeof message?.text==='string').map(message=>message.text.slice(0,220))
    :[];
  const models=Array.isArray(inventory?.models)?inventory.models:[];
  if(!models.some(model=>typeof model?.engine==='string'&&model.engine!=='fixture')&&!messages.length)
    messages.push('No supported local models were discovered. Check Ollama and refresh the route list.');
  return messages;
}
