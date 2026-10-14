// The relation graph's force layout off the main thread: graphs, drags and
// "restore layout" come in as messages, positions go back about 60 times a
// second as a transferred Float32Array until the layout comes to rest.
import { createLayoutHost } from "../utils/forceLayout.js";

const host = createLayoutHost((message) => {
  self.postMessage(message, [message.buffer.buffer]);
}, {
  schedule: (task, delay) => setTimeout(task, delay),
  cancel: (timer) => clearTimeout(timer),
});

self.onmessage = (event) => host.receive(event.data);
