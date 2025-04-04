'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {TestRunner, Message} from './main';

const Ansi = require('./Ansi');
const {
  CompositeDisposable,
  TextBuffer,
} = require('atom');
const React = require('react-for-atom');
const TestRunModel = require('./TestRunModel');
const TestRunnerPanel = require('./ui/TestRunnerPanel');
const TestSuiteModel = require('./TestSuiteModel');

const {array} = require('nuclide-commons');
const logger = require('nuclide-logging').getLogger();
const os = require('os');
const {track} = require('nuclide-analytics');

export type TestRunnerControllerState = {
  panelVisible?: boolean;
};

class TestRunnerController {

  _activeTestRunner: ?Object;
  _buffer: TextBuffer;
  _executionState: number;
  _panel: ?atom$Panel;
  _path: ?string;
  _root: ?Element;
  _run: ?TestRunModel;
  _state: Object;
  _testRunners: Set<TestRunner>;
  _testRunnerPanel: ?TestRunnerPanel;
  _testSuiteModel: ?TestSuiteModel;

  // Bound Functions for use as callbacks.
  clearOutput: Function;
  hidePanel: Function;
  stopTests: Function;
  _handleClickRun: Function;

  constructor(state: ?TestRunnerControllerState = {}, testRunners: Set<TestRunner>) {
    this._state = {
      panelVisible: state.panelVisible,
    };

    // TODO: Use the ReadOnlyTextBuffer class from nuclide-atom-text-editor when it is exported.
    this._buffer = new TextBuffer();
    // Make `delete` a no-op to effectively create a read-only buffer.
    this._buffer.delete = () => {};

    this._executionState = TestRunnerPanel.ExecutionState.STOPPED;
    this._testRunners = testRunners;
    this._renderPanel();

    // Bind Functions for use as callbacks;
    // TODO: Replace with property initializers when supported by Flow;
    this.clearOutput = this.clearOutput.bind(this);
    this.hidePanel = this.hidePanel.bind(this);
    this.stopTests = this.stopTests.bind(this);
    this._handleClickRun = this._handleClickRun.bind(this);
  }

  clearOutput() {
    this._buffer.setText('');
    this._path = undefined;
    this._run = undefined;
    this._stopListening();
    this._testSuiteModel = undefined;
    this._renderPanel();
  }

  destroy() {
    this._stopListening();
    if (this._root) {
      React.unmountComponentAtNode(this._root);
      this._root = null;
    }
    if (this._panel) {
      this._panel.destroy();
      this._panel = null;
    }
  }

  didUpdateTestRunners() {
    this._renderPanel();
  }

  hidePanel() {
    this.stopTests();
    this._state.panelVisible = false;
    if (this._panel) {
      this._panel.hide();
    }
  }

  /**
   * @return A Promise that resolves when testing has succesfully started.
   */
  async runTests(path?: string): Promise<void> {
    // If the test runner panel is not rendered yet, ensure it is rendered before continuing.
    if (this._testRunnerPanel == null || !this._state.panelVisible) {
      await new Promise((resolve, reject) => {
        this.showPanel(resolve);
      });
    }

    if (this._testRunnerPanel == null) {
      logger.error('Test runner panel did not render as expected. Aborting testing.');
      return;
    }

    // Get selected test runner when Flow knows `this._testRunnerPanel` is defined.
    const selectedTestRunner = this._testRunnerPanel.getSelectedTestRunner();
    if (!selectedTestRunner) {
      logger.warn(`No test runner selected. Active test runners: ${this._testRunners.size}`);
      return;
    }

    // 1. Use the `path` argument to this function
    // 2. Use `this._path` on the instance
    // 3. Let `testPath` be `undefined` so the path will be taken from the active `TextEditor`
    let testPath = (path === undefined) ? this._path : path;

    // If there's no path yet, get the path from the active `TextEditor`.
    if (testPath === undefined) {
      const activeTextEditor = atom.workspace.getActiveTextEditor();
      if (!activeTextEditor) {
        logger.debug('Attempted to run tests with no active text editor.');
        return;
      }

      // If the active text editor has no path, bail because there's nowhere to run tests.
      testPath = activeTextEditor.getPath();
      if (!testPath) {
        logger.warn('Attempted to run tests on an editor with no path.');
        return;
      }
    }

    this.clearOutput();
    this._runTestRunnerServiceForPath(
      selectedTestRunner.runTest(testPath),
      testPath,
      selectedTestRunner.label);
    track('testrunner-run-tests', {
      path: testPath,
      testRunner: selectedTestRunner.label,
    });

    // Set state as "Running" to give immediate feedback in the UI.
    this._setExecutionState(TestRunnerPanel.ExecutionState.RUNNING);
    this._path = testPath;
    this._renderPanel();
  }

  stopTests(): void {
    this._stopListening();

    // Respond in the UI immediately and assume the process is properly killed.
    this._setExecutionState(TestRunnerPanel.ExecutionState.STOPPED);
  }

  serialize(): TestRunnerControllerState {
    return this._state;
  }

  showPanel(didRender?: () => mixed): void {
    track('testrunner-show-panel');
    this._state.panelVisible = true;
    this._renderPanel(didRender);
    if (this._panel) {
      this._panel.show();
    }
  }

  togglePanel(): void {
    track('testrunner-hide-panel');
    if (this._state.panelVisible) {
      this.hidePanel();
    } else {
      this.showPanel();
    }
  }

  /**
   * Adds an end-of-line character to `text` and appends the resulting string to this controller's
   * text buffer.
   */
  _appendToBuffer(text: string): void {
    // `undo: 'skip'` disables the TextEditor's "undo system". Since the buffer is managed by this
    // class, an undo will never happen. Disable it when appending to prevent doing unneeded
    // bookkeeping.
    //
    // @see {@link https://atom.io/docs/api/v1.0.4/TextBuffer#instance-append|TextBuffer::append}
    this._buffer.append(`${text}${os.EOL}`, {undo: 'skip'});
  }

  _handleClickRun(event: SyntheticMouseEvent): void {
    // Don't pass a reference to `runTests` directly because the callback receives a mouse event as
    // its argument. `runTests` needs to be called with no arguments.
    this.runTests();
  }

  _runTestRunnerServiceForPath(testRun: Observable<Message>, path: NuclideUri, label: string):
      void {
    const subscription = testRun
      .doOnNext((message: Message) => {
        switch (message.kind) {
          case 'summary':
            this._testSuiteModel = new TestSuiteModel(message.summaryInfo);
            this._renderPanel();
            break;
          case 'run-test':
            const testInfo = message.testInfo;
            if (this._testSuiteModel) {
              this._testSuiteModel.addTestRun(testInfo);
            }

            // If a test run throws an exception, the stack trace is returned in 'details'.
            // Append its entirety to the console.
            if (testInfo.hasOwnProperty('details') && testInfo.details !== '') {
              this._appendToBuffer(testInfo.details);
            }

            // Append a PASS/FAIL message depending on whether the class has test failures.
            this._appendToBuffer(TestRunModel.formatStatusMessage(
              testInfo.name,
              testInfo.durationSecs,
              testInfo.status
            ));
            this._renderPanel();
            break;
          case 'start':
            if (this._run) {
              this._run.start();
            }
            break;
          case 'error':
            const error = message.error;
            if (this._run) {
              this._run.stop();
            }
            if (error.code === 'ENOENT') {
              this._appendToBuffer(
                `${Ansi.YELLOW}Command '${error.path}' does not exist${Ansi.RESET}`);
              this._appendToBuffer(`${Ansi.YELLOW}Are you trying to run remotely?${Ansi.RESET}`);
              this._appendToBuffer(`${Ansi.YELLOW}Path: ${path}${Ansi.RESET}`);
            }
            this._appendToBuffer(`${Ansi.RED}Original Error: ${error.message}${Ansi.RESET}`);
            this._setExecutionState(TestRunnerPanel.ExecutionState.STOPPED);
            logger.error(`Error running tests: "${error.message}"`);
            break;
          case 'stderr':
            // Color stderr output red in the console to distinguish it as error.
            this._appendToBuffer(`${Ansi.RED}${message.data}${Ansi.RESET}`);
            break;
        }
      })
      .finally(() => {
        this._stopListening();
        this._setExecutionState(TestRunnerPanel.ExecutionState.STOPPED);
      })
      .subscribe();
    this._run = new TestRunModel(label, subscription.dispose.bind(subscription));
  }

  _setExecutionState(executionState: number): void {
    this._executionState = executionState;
    this._renderPanel();
  }

  _renderPanel(didRender?: () => mixed) {
    // Initialize and render the contents of the panel only if the hosting container is visible by
    // the user's choice.
    if (!this._state.panelVisible) {
      return;
    }

    let root = this._root;

    if (!root) {
      root = document.createElement('div');
      this._root = root;
    }

    let progressValue;
    if  (this._testSuiteModel && this._executionState === TestRunnerPanel.ExecutionState.RUNNING) {
      progressValue = this._testSuiteModel.progressPercent();
    } else {
      // If there is no running test suite, fill the progress bar because there is no progress to
      // track.
      progressValue = 100;
    }

    this._testRunnerPanel = React.render(
      <TestRunnerPanel
        buffer={this._buffer}
        executionState={this._executionState}
        onClickClear={this.clearOutput}
        onClickClose={this.hidePanel}
        onClickRun={this._handleClickRun}
        onClickStop={this.stopTests}
        path={this._path}
        progressValue={progressValue}
        runDuration={this._run && this._run.getDuration()}
        // `TestRunnerPanel` expects an Array so it can render the test runners in a dropdown and
        // maintain a selected index. `Set` maintains items in insertion order, so the ordering is
        // determinate on each render.
        testRunners={array.from(this._testRunners)}
        testSuiteModel={this._testSuiteModel}
      />,
      root,
      didRender
    );

    if (!this._panel) {
      this._panel = atom.workspace.addBottomPanel({item: root, visible: this._state.panelVisible});
    }
  }

  _stopListening(): void {
    if (this._run && (this._run.dispose != null)) {
      try {
        const dispose = this._run.dispose;
        this._run.dispose = null;
        this._run.stop();
        track('testrunner-stop-tests', {
          testRunner: this._run.label,
        });
        dispose();
      } catch (e) {
        // If the remote connection goes away, it won't be possible to stop tests. Log an error and
        // proceed as usual.
        logger.error(`Error when stopping test run #'${this._run.label}: ${e}`);
      }
    }
  }

}

module.exports = TestRunnerController;
