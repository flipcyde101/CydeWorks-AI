// Test-only approximation of Electron's utility-process parent port.
const {EventEmitter}=require('node:events');
const parent=new EventEmitter();
parent.postMessage=message=>{if(process.connected)process.send(message);};
process.parentPort=parent;
process.on('message',data=>parent.emit('message',{data}));
void import('../server.mjs');
