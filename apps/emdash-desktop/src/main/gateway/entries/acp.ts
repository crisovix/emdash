import { createAcpComponent } from '@emdash/core/runtimes/acp/node';
import { pluginRegistry, poolAvailability } from '@emdash/plugins/agents';
import { runWireComponentWorker } from '@emdash/wire/worker';
import { initWorkerProcessLogging } from '@emdash/wire/worker/node';

const logger = initWorkerProcessLogging('acp-runtime');
void runWireComponentWorker(createAcpComponent({ pluginRegistry }), { logger });

// See the tui-agents entry: the availability snapshot is per worker process, so
// each one warms up its own or the session's first spawn routes blind.
void poolAvailability.refresh(Date.now());
