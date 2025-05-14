/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strictEqual } from 'assert';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ITerminalChildProcess } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalInstanceService } from '../../browser/terminal.js';
import { TerminalProcessManager } from '../../browser/terminalProcessManager.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';

class TestTerminalChildProcess implements ITerminalChildProcess {
	id: number = 0;
	get capabilities() { return []; }
	constructor(
		readonly shouldPersist: boolean
	) {
	}
	updateProperty(property: any, value: any): Promise<void> {
		throw new Error('Method not implemented.');
	}

	onProcessOverrideDimensions?: Event<any> | undefined;
	onProcessResolvedShellLaunchConfig?: Event<any> | undefined;
	onDidChangeHasChildProcesses?: Event<any> | undefined;

	onDidChangeProperty = Event.None;
	onProcessData = Event.None;
	onProcessExit = Event.None;
	onProcessReady = Event.None;
	onProcessTitleChanged = Event.None;
	onProcessShellTypeChanged = Event.None;
	async start(): Promise<undefined> { return undefined; }
	shutdown(immediate: boolean): void { }
	input(data: string): void { }
	resize(cols: number, rows: number): void { }
	clearBuffer(): void { }
	acknowledgeDataEvent(charCount: number): void { }
	async setUnicodeVersion(version: '6' | '11'): Promise<void> { }
	async getInitialCwd(): Promise<string> { return ''; }
	async getCwd(): Promise<string> { return ''; }
	async processBinary(data: string): Promise<void> { }
	refreshProperty(property: any): Promise<any> { return Promise.resolve(''); }
}

class TestTerminalInstanceService implements Partial<ITerminalInstanceService> {
	getBackend() {
		return {
			onPtyHostExit: Event.None,
			onPtyHostUnresponsive: Event.None,
			onPtyHostResponsive: Event.None,
			onPtyHostRestart: Event.None,
			onDidMoveWindowInstance: Event.None,
			onDidRequestDetach: Event.None,
			createProcess: (
				shellLaunchConfig: any,
				cwd: string,
				cols: number,
				rows: number,
				unicodeVersion: '6' | '11',
				env: any,
				windowsEnableConpty: boolean,
				shouldPersist: boolean
			) => new TestTerminalChildProcess(shouldPersist),
			getLatency: () => Promise.resolve([])
		} as any;
	}
}

suite('Workbench - TerminalProcessManager', () => {
	let manager: TerminalProcessManager;

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	setup(async () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const configurationService = instantiationService.get(IConfigurationService) as TestConfigurationService;
		await configurationService.setUserConfiguration('editor', { fontFamily: 'foo' });
		await configurationService.setUserConfiguration('terminal', {
			integrated: {
				fontFamily: 'bar',
				enablePersistentSessions: true,
				shellIntegration: {
					enabled: false
				}
			}
		});
		configurationService.onDidChangeConfigurationEmitter.fire({
			affectsConfiguration: () => true,
		} as any);
		instantiationService.stub(ITerminalInstanceService, new TestTerminalInstanceService());

		manager = store.add(instantiationService.createInstance(TerminalProcessManager, 1, undefined, undefined, undefined));
	});


	suite('process persistence', () => {
		suite('local', () => {
			test('regular terminal should persist', async () => {
				const p = await manager.createProcess({
				}, 1, 1, false);
				strictEqual(p, undefined);
				strictEqual(manager.shouldPersist, true);
			});
			test('task terminal should not persist', async () => {
				const p = await manager.createProcess({
					isFeatureTerminal: true
				}, 1, 1, false);
				strictEqual(p, undefined);
				strictEqual(manager.shouldPersist, false);
			});
		});
		suite('remote', () => {
			const remoteCwd = URI.from({
				scheme: Schemas.vscodeRemote,
				path: 'test/cwd'
			});

			test('regular terminal should persist', async () => {
				const p = await manager.createProcess({
					cwd: remoteCwd
				}, 1, 1, false);
				strictEqual(p, undefined);
				strictEqual(manager.shouldPersist, true);
			});
			test('task terminal should not persist', async () => {
				const p = await manager.createProcess({
					isFeatureTerminal: true,
					cwd: remoteCwd
				}, 1, 1, false);
				strictEqual(p, undefined);
				strictEqual(manager.shouldPersist, false);
			});
		});
	});

	suite('event listeners', () => {
		suite('lifecycle', () => {
			test('should properly dispose event listeners between terminals', async () => {
				// Track how many listeners are registered
				let readyListenersCount = 0;
				let exitListenersCount = 0;
				let propertyListenersCount = 0;

				// Create a child process with trackable event listeners
				class EventTrackingProcess extends TestTerminalChildProcess {
					private readonly _onProcessReady = new Emitter<any>({
						onDidAddFirstListener: () => readyListenersCount++,
						onDidRemoveLastListener: () => readyListenersCount--
					});
					private readonly _onProcessExit = new Emitter<number>({
						onDidAddFirstListener: () => exitListenersCount++,
						onDidRemoveLastListener: () => exitListenersCount--
					});
					private readonly _onDidChangeProperty = new Emitter<any>({
						onDidAddFirstListener: () => propertyListenersCount++,
						onDidRemoveLastListener: () => propertyListenersCount--
					});

					override onProcessReady = this._onProcessReady.event;
					override onProcessExit = this._onProcessExit.event;
					override onDidChangeProperty = this._onDidChangeProperty.event;

					fireEvents(): void {
						this._onProcessReady.fire({});
						this._onProcessExit.fire(0);
						this._onDidChangeProperty.fire({});
					}

					override shutdown(immediate: boolean): void {
						this._onProcessReady.dispose();
						this._onProcessExit.dispose();
						this._onDidChangeProperty.dispose();
					}
				}

				// Override terminal instance service
				const testService: Partial<ITerminalInstanceService> = {
					getBackend: () => ({
						...new TestTerminalInstanceService().getBackend(),
						createProcess: () => new EventTrackingProcess(true)
					})
				};

				const instantiationService = workbenchInstantiationService(undefined, store);
				instantiationService.stub(ITerminalInstanceService, testService);

				// Create first terminal
				const manager1 = store.add(instantiationService.createInstance(TerminalProcessManager, 1, undefined, undefined, undefined));
				await manager1.createProcess({}, 1, 1, false);

				// Verify initial listener count
				strictEqual(readyListenersCount, 1, 'Should have 1 ready listener initially');
				strictEqual(exitListenersCount, 1, 'Should have 1 exit listener initially');
				strictEqual(propertyListenersCount, 1, 'Should have 1 property listener initially');

				// Create second terminal
				const manager2 = store.add(instantiationService.createInstance(TerminalProcessManager, 2, undefined, undefined, undefined));
				await manager2.createProcess({}, 1, 1, false);

				// Verify listener count after second terminal
				strictEqual(readyListenersCount, 2, 'Should have 2 ready listeners temporarily');
				strictEqual(exitListenersCount, 2, 'Should have 2 exit listeners temporarily');
				strictEqual(propertyListenersCount, 2, 'Should have 2 property listeners temporarily');

				// Dispose first terminal and verify listeners are cleaned up
				manager1.dispose();

				// Verify listener count after dispose
				strictEqual(readyListenersCount, 0, 'Should maintain 0 ready listener after dispose');
				strictEqual(exitListenersCount, 0, 'Should maintain 0 exit listener after dispose');
				strictEqual(propertyListenersCount, 0, 'Should maintain 0 property listener after dispose');
			});
		});
	});
});
