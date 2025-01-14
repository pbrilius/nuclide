'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

type PackageName = string;
type PackageVersion = string;

type InstallConfigEntry = {
  name: PackageName;
  version: PackageVersion;
};

type InstallConfig = {
  packages: Array<InstallConfigEntry>;
};

/**
 * Installs the Atom packages specified in the config.
 * @return Promise that is fulfilled with a boolean indicating whether the installation succeeded or
 *   failed.
 */
async function installPackagesInConfig(config: InstallConfig): Promise<boolean> {
  const installedPackages = await getInstalledPackages();
  const packagesToInstall = findPackagesToInstall(config, installedPackages);
  const numPackages = packagesToInstall.length;
  if (numPackages === 0) {
    return true;
  }

  // Create a progress bar to show what percentage of the packages are installed.
  let numInstalled = 0;
  const progress = window.document.createElement('progress');
  progress.max = numPackages;
  progress.value = 0;
  progress.className = 'display-inline';
  progress.style.width = '100%';

  // Display a notification telling the user that installation has started.
  let ellipsisLength = 0;
  const notification = atom.notifications.addInfo(
    createInstallationMessage(numPackages, ellipsisLength),
    {
      // The detail property cannot be empty or else the DOM nodes we hook into in the following
      // section will not be present.
      detail: 'Starting installation...',
      dismissable: true,
    },
  );
  let timerId: ?number;
  notification.onDidDismiss(() => { if (timerId) { clearInterval(timerId); } });

  // Extract the DOM elements of interest from the notification.
  // The structure of the <atom-notification> element can be found at:
  // https://github.com/atom/notifications/blob/master/lib/notification-element.coffee.
  const notificationEl = atom.views.getView(notification);
  const messageEl = notificationEl.querySelector('.message');
  const notificationContentEl = notificationEl.querySelector('.detail-content');
  let detailTextElement: ?HTMLElement;
  let messageParagraphElement: ?HTMLElement;

  // Defensive checks in case the DOM structure changes.
  if (notificationContentEl) {
    detailTextElement = notificationContentEl.firstElementChild;
    notificationContentEl.appendChild(progress);
  }
  if (messageEl) {
    messageParagraphElement = messageEl.firstElementChild;
  }

  // Keep track of the packages that are currently being installed and keep the contents of the
  // notification up to date with what is currently being installed.
  const currentlyInstalling = new Set();

  function updateMessage() {
    if (messageParagraphElement) {
      messageParagraphElement.innerText = createInstallationMessage(numPackages - numInstalled,
        ellipsisLength);
    }
  }

  function render() {
    if (detailTextElement) {
      const {from} = require('nuclide-commons').array;
      detailTextElement.innerText = `Installing ${from(currentlyInstalling).join(', ')}`;
    }
    updateMessage();
  }

  timerId = setInterval(function() {
    ellipsisLength = (ellipsisLength + 1) % 3;
    updateMessage();
  }, 1000);

  // Callbacks to report the progress of individual package installation.
  function onBeginInstallation(packageName: string) {
    currentlyInstalling.add(packageName);
    render();
  }
  function onFinishInstallation(packageName: string) {
    progress.value = ++numInstalled;
    currentlyInstalling.delete(packageName);
    render();
  }

  // Perform the installation.
  let failure: ?Error;
  try {
    await installApmPackages(packagesToInstall, onBeginInstallation, onFinishInstallation);
  } catch (e) {
    failure = e;
  }
  notification.dismiss();

  // Report the result of the installation to the user.
  if (failure) {
    // Write the error to the console to help the user debug the issue.
    console.error(failure); // eslint-disable-line no-console

    atom.notifications.addError(
      `There was an error installing Nuclide packages:\n${failure.stack || failure}`);
  } else {
    atom.notifications.addSuccess(
      `${numPackages} Nuclide package${numPackages === 1 ? '' : 's'} installed.`);
  }

  return failure != null;
}

function createInstallationMessage(numPackages: number, ellipsisLength: number): string {
  return `Installing ${numPackages} Nuclide package${numPackages === 1 ? '' : 's'}` +
    '.'.repeat(ellipsisLength + 1);
}

/**
 * Calls `apm ls --json`, parses the JSON written to stdout, and filters the value
 * of the `"user"` property of the JSON to produce a map of (name, version) pairs
 * that correspond to user-installed Atom packages.
 */
async function getInstalledPackages(): Promise<{[key: PackageName]: PackageVersion}> {
  const {asyncExecute} = require('nuclide-commons');
  const apm = atom.packages.getApmPath();
  let json;
  try {
    const {stdout} = await asyncExecute(apm, ['ls', '--json']);
    json = stdout;
  } catch (e) {
    /*eslint-disable no-console*/
    // Write to the console because this make it easier for users to report errors.
    console.error(`Could not get the list of Atom packages from ${apm} ls --json.`);
    /*eslint-enable no-console*/
    throw Error(`${apm} ls --json failed with exit code ${e.exitCode}`);
  }

  const installedPackages = {};
  JSON.parse(json)['user'].forEach(pkg => {
    installedPackages[pkg['name']] = pkg['version'];
  });
  return installedPackages;
}

function findPackagesToInstall(
  config: InstallConfig,
  installedPackages: {[key: PackageName]: PackageVersion}
  ): Array<string> {
  const packagesToInstall = [];
  const semver = require('semver');
  config.packages.forEach(pkg => {
    const {name, version} = pkg;
    if (!name) {
      throw Error(`Entry without a name in ${JSON.stringify(config, null, 2)}`);
    }
    if (!version) {
      throw Error(`Entry without a version in ${JSON.stringify(config, null, 2)}`);
    }
    if (installedPackages.hasOwnProperty(name)) {
      // Only install the specified version if the current version is less than the requested
      // version.
      if (semver.lt(installedPackages[name], version)) {
        packagesToInstall.push(`${name}@${version}`);
      }
    } else {
      packagesToInstall.push(`${name}@${version}`);
    }
  });
  return packagesToInstall;
}

/**
 * Installs the list of Atom packages serially.
 */
function installApmPackages(
  packages: Array<string>,
  onBeginInstallation: (packageName: string) => void,
  onFinishInstallation: (packageName: string) => void,
): Promise {
  const {asyncExecute, PromisePool} = require('nuclide-commons');
  // Use ~25% of the number of cores so that the installer does not eat up all the resources.
  const poolSize = Math.max(Math.ceil(require('os').cpus().length / 4), 1);
  const pool = new PromisePool(poolSize);
  const apm = atom.packages.getApmPath();
  const promises = [];
  packages.forEach(pkg => {
    const executor = (resolve, reject) => {
      onBeginInstallation(pkg);
      asyncExecute(apm, ['install', '--production', pkg])
        .then(() => onFinishInstallation(pkg))
        .then(resolve, reject);
    };
    const promise = pool.submit(executor);
    promises.push(promise);
  });
  return Promise.all(promises);
}

module.exports = {
  installPackagesInConfig,
  __test__: {
    findPackagesToInstall,
  },
};
