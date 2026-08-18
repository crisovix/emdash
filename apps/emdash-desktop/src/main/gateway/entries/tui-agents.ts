import { createTuiAgentsComponent } from '@emdash/core/runtimes/tui-agents/node';
import { pluginRegistry, poolAvailability } from '@emdash/plugins/agents';
import { runWireComponentWorker } from '@emdash/wire/worker';
import { initWorkerProcessLogging } from '@emdash/wire/worker/node';

const logger = initWorkerProcessLogging('tui-agents-runtime');
void runWireComponentWorker(createTuiAgentsComponent({ pluginRegistry }), { logger });

// Account Pool availability is a per-process snapshot that only refreshes when a
// spawn asks for it, so without this the first task of the session cannot know an
// account is rate-limited. Warming it up here — fire and forget, and cheap — means
// avoidance works from the first spawn instead of the second.
void poolAvailability.refresh(Date.now());
