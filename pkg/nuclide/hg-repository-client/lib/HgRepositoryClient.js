'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {
  DiffInfo,
  HgStatusOptionValue,
  HgRepositoryOptions,
  LineDiff,
  RevisionInfo,
  RevisionFileChanges,
  StatusCodeIdValue,
  StatusCodeNumberValue,
} from 'nuclide-hg-repository-base/lib/hg-constants';

import type {
  HgService,
} from 'nuclide-hg-repository-base/lib/HgService.js';

import {CompositeDisposable, Emitter} from 'atom';
import {
  StatusCodeId,
  StatusCodeIdToNumber,
  StatusCodeNumber,
  HgStatusOption,
} from 'nuclide-hg-repository-base/lib/hg-constants';
import {debounce} from 'nuclide-commons';
import {ensureTrailingSeparator} from 'nuclide-commons/lib/paths';
import {addAllParentDirectoriesToCache, removeAllParentDirectoriesFromCache} from './utils';

/**
 *
 * Section: Constants, Type Definitions
 *
 */

export type HgStatusCommandOptions = {
  hgStatusOption: HgStatusOptionValue;
};

const EDITOR_SUBSCRIPTION_NAME = 'hg-repository-editor-subscription';
export const DEBOUNCE_MILLISECONDS_FOR_REFRESH_ALL = 500;
export const MAX_INDIVIDUAL_CHANGED_PATHS = 1;

function filterForOnlyNotIgnored(code: StatusCodeIdValue): boolean {
  return (code !== StatusCodeId.IGNORED);
}

function filterForOnlyIgnored(code: StatusCodeIdValue): boolean {
  return (code === StatusCodeId.IGNORED);
}

function filterForAllStatues() {
  return true;
}


/**
 *
 * Section: HgRepositoryClient
 *
 */

/**
 * HgRepositoryClient runs on the machine that Nuclide/Atom is running on.
 * It is the interface that other Atom packages will use to access Mercurial.
 * It caches data fetched from an HgService.
 * It implements the same interface as GitRepository, (https://atom.io/docs/api/latest/GitRepository)
 * in addition to providing asynchronous methods for some getters.
 */

import type {NuclideUri} from 'nuclide-remote-uri';

export default class HgRepositoryClient {
  _path: string;
  _workingDirectory: atom$Directory;
  _projectDirectory: atom$Directory;
  _originURL: string;
  _service: HgService;
  _emitter: Emitter;
  // A map from a key (in most cases, a file path), to a related Disposable.
  _disposables: {[key: string]: atom$IDisposable};
  _hgStatusCache: {[filePath: NuclideUri]: StatusCodeIdValue};
  // Map of directory path to the number of modified files within that directory.
  _modifiedDirectoryCache: Map<string, number>;
  _hgDiffCache: {[filePath: NuclideUri]: DiffInfo};
  _hgDiffCacheFilesUpdating: Set<NuclideUri>;
  _hgDiffCacheFilesToClear: Set<NuclideUri>;

  // A debounced function that eventually calls _doRefreshStatusesOfAllFilesInCache.
  _debouncedRefreshAll: ?() => mixed;
  _isRefreshingAllFilesInCache: boolean;

  _currentBookmark: ?string;

  constructor(repoPath: string, hgService: HgService, options: HgRepositoryOptions) {
    this._path = repoPath;
    this._workingDirectory = options.workingDirectory;
    this._projectDirectory = options.projectRootDirectory;
    this._originURL = options.originURL;
    this._service = hgService;

    this._emitter = new Emitter();
    this._disposables = {};

    this._hgStatusCache = {};
    this._modifiedDirectoryCache = new Map();

    this._hgDiffCache = {};
    this._hgDiffCacheFilesUpdating = new Set();
    this._hgDiffCacheFilesToClear = new Set();
    this._disposables[EDITOR_SUBSCRIPTION_NAME] = atom.workspace.observeTextEditors(editor => {
      const filePath = editor.getPath();
      if (!filePath) {
        // TODO: observe for when this editor's path changes.
        return;
      }
      if (!this._isPathRelevant(filePath)) {
        return;
      }
      // If this editor has been previously active, we will have already
      // initialized diff info and registered listeners on it.
      if (this._disposables[filePath]) {
        return;
      }
      // TODO (t8227570) Get initial diff stats for this editor, and refresh
      // this information whenever the content of the editor changes.
      const editorSubscriptions = this._disposables[filePath] = new CompositeDisposable();
      editorSubscriptions.add(editor.onDidSave(event => {
        this._updateDiffInfo([event.path]);
      }));
      // Remove the file from the diff stats cache when the editor is closed.
      // This isn't strictly necessary, but keeps the cache as small as possible.
      // There are cases where this removal may result in removing information
      // that is still relevant: e.g.
      //   * if the user very quickly closes and reopens a file; or
      //   * if the file is open in multiple editors, and one of those is closed.
      // These are probably edge cases, though, and the information will be
      // refetched the next time the file is edited.
      editorSubscriptions.add(editor.onDidDestroy(() => {
        this._hgDiffCacheFilesToClear.add(filePath);
        this._disposables[filePath].dispose();
        delete this._disposables[filePath];
      }));
    });

    // Get updates that tell the HgRepositoryClient when to clear its caches.
    this._service.observeFilesDidChange().subscribe(this._filesDidChange.bind(this));
    this._service.observeHgIgnoreFileDidChange()
      .subscribe(this._refreshStatusesOfAllFilesInCache.bind(this));
    this._service.observeHgRepoStateDidChange()
      .subscribe(this._refreshStatusesOfAllFilesInCache.bind(this));
    this._service.observeHgBookmarkDidChange()
      .subscribe(this.fetchCurrentBookmark.bind(this));

    this._isRefreshingAllFilesInCache = false;
  }

  destroy() {
    this._emitter.emit('did-destroy');
    this._emitter.dispose();
    Object.keys(this._disposables).forEach((key) => {
      this._disposables[key].dispose();
    });
    this._service.dispose();
  }

  /**
   *
   * Section: Event Subscription
   *
   */

  onDidDestroy(callback: () => {}): atom$Disposable {
    return this._emitter.on('did-destroy', callback);
  }

  onDidChangeStatus(
    callback: (event: {path: string; pathStatus: StatusCodeNumberValue}) => {}
  ): atom$Disposable {
    return this._emitter.on('did-change-status', callback);
  }

  onDidChangeStatuses(callback: () => {}): atom$Disposable {
    return this._emitter.on('did-change-statuses', callback);
  }


  /**
   *
   * Section: Repository Details
   *
   */

  getType(): string {
    return 'hg';
  }

  getPath(): string {
    return this._path;
  }

  getWorkingDirectory(): string {
    return this._workingDirectory.getPath();
  }

  // @return The path of the root project folder in Atom that this
  // HgRepositoryClient provides information about.
  getProjectDirectory(): string {
    return this._projectDirectory.getPath();
  }

  // TODO This is a stub.
  isProjectAtRoot(): boolean {
    return true;
  }

  relativize(filePath: NuclideUri): string {
    return this._workingDirectory.relativize(filePath);
  }

  // TODO This is a stub.
  hasBranch(branch: string): boolean {
    return false;
  }

  /**
   * @return The current Hg bookmark.
   */
  getShortHead(filePath: NuclideUri): string {
    if (!this._currentBookmark) {
      // Kick off a fetch to get the current bookmark. This is async.
      this.fetchCurrentBookmark();
      return '';
    }
    return this._currentBookmark;
  }

  // TODO This is a stub.
  isSubmodule(path: NuclideUri): boolean {
    return false;
  }

  // TODO This is a stub.
  getAheadBehindCount(reference: string, path: NuclideUri): number {
    return 0;
  }

  // TODO This is a stub.
  getCachedUpstreamAheadBehindCount(path: ?NuclideUri): {ahead: number; behind: number;} {
    return {
      ahead: 0,
      behind: 0,
    };
  }

  // TODO This is a stub.
  getConfigValue(key: string, path: ?string): ?string {
    return null;
  }

  getOriginURL(path: ?string): ?string {
    return this._originURL;
  }

  // TODO This is a stub.
  getUpstreamBranch(path: ?string): ?string {
    return null;
  }

  // TODO This is a stub.
  getReferences(
    path: ?NuclideUri,
  ): {heads: Array<string>; remotes: Array<string>; tags: Array<string>;} {
    return {
      heads: [],
      remotes: [],
      tags: [],
    };
  }

  // TODO This is a stub.
  getReferenceTarget(reference: string, path: ?NuclideUri): ?string {
    return null;
  }


  /**
   *
   * Section: Reading Status (parity with GitRepository)
   *
   */

  // TODO (jessicalin) Can we change the API to make this method return a Promise?
  // If not, might need to do a synchronous `hg status` query.
  isPathModified(filePath: ?NuclideUri): boolean {
    if (!filePath) {
      return false;
    }
    const cachedPathStatus = this._hgStatusCache[filePath];
    if (!cachedPathStatus) {
      return false;
    } else {
      return this.isStatusModified(StatusCodeIdToNumber[cachedPathStatus]);
    }
  }

  // TODO (jessicalin) Can we change the API to make this method return a Promise?
  // If not, might need to do a synchronous `hg status` query.
  isPathNew(filePath: ?NuclideUri): boolean {
    if (!filePath) {
      return false;
    }
    const cachedPathStatus = this._hgStatusCache[filePath];
    if (!cachedPathStatus) {
      return false;
    } else {
      return this.isStatusNew(StatusCodeIdToNumber[cachedPathStatus]);
    }
  }

  // TODO (jessicalin) Can we change the API to make this method return a Promise?
  // If not, this method lies a bit by using cached information.
  // TODO (jessicalin) Make this work for ignored directories.
  isPathIgnored(filePath: ?NuclideUri): boolean {
    if (!filePath) {
      return false;
    }
    // `hg status -i` does not list the repo (the .hg directory), presumably
    // because the repo does not track itself.
    // We want to represent the fact that it's not part of the tracked contents,
    // so we manually add an exception for it via the _isPathWithinHgRepo check.
    return (this._hgStatusCache[filePath] === StatusCodeId.IGNORED) ||
        this._isPathWithinHgRepo(filePath);
  }

  /**
   * Checks if the given path is within the repo directory (i.e. `.hg/`).
   */
  _isPathWithinHgRepo(filePath: NuclideUri): boolean {
    return (filePath === this.getPath()) || (filePath.indexOf(this.getPath() + '/') === 0);
  }

  /**
   * Checks whether a path is relevant to this HgRepositoryClient. A path is
   * defined as 'relevant' if it is within the project directory opened within the repo.
   */
  _isPathRelevant(filePath: NuclideUri): boolean {
    return this._projectDirectory.contains(filePath) ||
           (this._projectDirectory.getPath() === filePath);
  }

  // For now, this method only reflects the status of "modified" directories.
  // Tracking directory status isn't straightforward, as Hg only tracks files.
  // http://mercurial.selenic.com/wiki/FAQ#FAQ.2FCommonProblems.I_tried_to_check_in_an_empty_directory_and_it_failed.21
  // TODO: Make this method reflect New and Ignored statuses.
  getDirectoryStatus(directoryPath: ?string): StatusCodeNumberValue {
    if (!directoryPath) {
      return StatusCodeNumber.CLEAN;
    }
    const directoryPathWithSeparator = ensureTrailingSeparator(directoryPath);
    if (this._modifiedDirectoryCache.has(directoryPathWithSeparator)) {
      return StatusCodeNumber.MODIFIED;
    }
    return StatusCodeNumber.CLEAN;
  }

  // We don't want to do any synchronous 'hg status' calls. Just use cached values.
  getPathStatus(filePath: NuclideUri): StatusCodeNumberValue {
    return this.getCachedPathStatus(filePath);
  }

  getCachedPathStatus(filePath: ?NuclideUri): StatusCodeNumberValue {
    if (!filePath) {
      return StatusCodeNumber.CLEAN;
    }
    const cachedStatus = this._hgStatusCache[filePath];
    if (cachedStatus) {
      return StatusCodeIdToNumber[cachedStatus];
    }
    return StatusCodeNumber.CLEAN;
  }

  getAllPathStatuses(): {[filePath: NuclideUri]: StatusCodeNumberValue} {
    const pathStatuses = Object.create(null);
    for (const filePath in this._hgStatusCache) {
      pathStatuses[filePath] = StatusCodeIdToNumber[this._hgStatusCache[filePath]];
    }
    return pathStatuses;
  }

  isStatusModified(status: ?number): boolean {
    return (
      status === StatusCodeNumber.MODIFIED ||
      status === StatusCodeNumber.MISSING ||
      status === StatusCodeNumber.REMOVED
    );
  }

  isStatusNew(status: ?number): boolean {
    return (
      status === StatusCodeNumber.ADDED ||
      status === StatusCodeNumber.UNTRACKED
    );
  }


  /**
   *
   * Section: Reading Hg Status (async methods)
   *
   */

  /**
   * Recommended method to use to get the status of files in this repo.
   * @param paths An array of file paths to get the status for. If a path is not in the
   *   project, it will be ignored.
   * See HgService::getStatuses for more information.
   */
  async getStatuses(
    paths: Array<string>,
    options: HgStatusCommandOptions,
  ): Promise<Map<NuclideUri, StatusCodeNumberValue>> {
    const statusMap = new Map();
    const isRelavantStatus = this._getPredicateForRelevantStatuses(options);

    // Check the cache.
    // Note: If paths is empty, a full `hg status` will be run, which follows the spec.
    const pathsWithCacheMiss = [];
    paths.forEach((filePath) => {
      const statusId = this._hgStatusCache[filePath];
      if (statusId) {
        if (!isRelavantStatus(statusId)) {
          return;
        }
        statusMap.set(filePath, StatusCodeIdToNumber[statusId]);
      } else {
        pathsWithCacheMiss.push(filePath);
      }
    });

    // Fetch any uncached statuses.
    if (pathsWithCacheMiss.length) {
      const newStatusInfo = await this._updateStatuses(pathsWithCacheMiss, options);
      newStatusInfo.forEach((status, filePath) => {
        statusMap.set(filePath, StatusCodeIdToNumber[status]);
      });
    }
    return statusMap;
  }

  /**
   * Fetches the statuses for the given file paths, and updates the cache and
   * sends out change events as appropriate.
   * @param filePaths An array of file paths to update the status for. If a path
   *   is not in the project, it will be ignored.
   */
  async _updateStatuses(
    filePaths: Array<string>,
    options: HgStatusCommandOptions,
  ): Promise<Map<NuclideUri, StatusCodeIdValue>> {
    const pathsInRepo = filePaths.filter((filePath) => {
      return this._isPathRelevant(filePath);
    });
    if (pathsInRepo.length === 0) {
      return new Map();
    }

    const statusMapPathToStatusId = await this._service.fetchStatuses(pathsInRepo, options);

    const queriedFiles = new Set(pathsInRepo);
    const statusChangeEvents = [];
    statusMapPathToStatusId.forEach((newStatusId, filePath) => {

      const oldStatus = this._hgStatusCache[filePath];
      if (oldStatus && (oldStatus !== newStatusId) ||
          !oldStatus && (newStatusId !== StatusCodeId.CLEAN)) {
        statusChangeEvents.push({
          path: filePath,
          pathStatus: StatusCodeIdToNumber[newStatusId],
        });
        if (newStatusId === StatusCodeId.CLEAN) {
          // Don't bother keeping 'clean' files in the cache.
          delete this._hgStatusCache[filePath];
          this._removeAllParentDirectoriesFromCache(filePath);
        } else {
          this._hgStatusCache[filePath] = newStatusId;
          if (newStatusId === StatusCodeId.MODIFIED) {
            this._addAllParentDirectoriesToCache(filePath);
          }
        }
      }
      queriedFiles.delete(filePath);
    });

    // If the statuses were fetched for only changed (`hg status`) or
    // ignored ('hg status --ignored`) files, a queried file may not be
    // returned in the response. If it wasn't returned, this means its status
    // may have changed, in which case it should be removed from the hgStatusCache.
    // Note: we don't know the real updated status of the file, so don't send a change event.
    // TODO (jessicalin) Can we make the 'pathStatus' field in the change event optional?
    // Then we can send these events.
    const hasOptions = options && ('hgStatusOption' in options);
    if (hasOptions && (options.hgStatusOption === HgStatusOption.ONLY_IGNORED)) {
      queriedFiles.forEach((filePath) => {
        if (this._hgStatusCache[filePath] === StatusCodeId.IGNORED) {
          delete this._hgStatusCache[filePath];
        }
      });
    } else if (hasOptions && (options.hgStatusOption === HgStatusOption.ALL_STATUSES)) {
      // If HgStatusOption.ALL_STATUSES was passed and a file does not appear in
      // the results, it must mean the file was removed from the filesystem.
      queriedFiles.forEach((filePath) => {
        const cachedStatusId = this._hgStatusCache[filePath];
        delete this._hgStatusCache[filePath];
        if (cachedStatusId === StatusCodeId.MODIFIED) {
          this._removeAllParentDirectoriesFromCache(filePath);
        }
      });
    } else {
      queriedFiles.forEach((filePath) => {
        const cachedStatusId = this._hgStatusCache[filePath];
        if (cachedStatusId !== StatusCodeId.IGNORED) {
          delete this._hgStatusCache[filePath];
          if (cachedStatusId === StatusCodeId.MODIFIED) {
            this._removeAllParentDirectoriesFromCache(filePath);
          }
        }
      });
    }

    // Emit change events only after the cache has been fully updated.
    statusChangeEvents.forEach((event) => {
      this._emitter.emit('did-change-status', event);
    });
    this._emitter.emit('did-change-statuses');

    return statusMapPathToStatusId;
  }

  _addAllParentDirectoriesToCache(filePath: NuclideUri) {
    addAllParentDirectoriesToCache(
      this._modifiedDirectoryCache,
      filePath,
      this._projectDirectory.getParent().getPath()
    );
  }

  _removeAllParentDirectoriesFromCache(filePath: NuclideUri) {
    removeAllParentDirectoriesFromCache(
      this._modifiedDirectoryCache,
      filePath,
      this._projectDirectory.getParent().getPath()
    );
  }

  /**
   * Helper function for ::getStatuses.
   * Returns a filter for whether or not the given status code should be
   * returned, given the passed-in options for ::getStatuses.
   */
  _getPredicateForRelevantStatuses(
    options: HgStatusCommandOptions
  ): (code: StatusCodeIdValue) => boolean {
    const hasOptions = options && ('hgStatusOption' in options);

    if (hasOptions && (options.hgStatusOption === HgStatusOption.ONLY_IGNORED)) {
      return filterForOnlyIgnored;
    } else if (hasOptions && (options.hgStatusOption === HgStatusOption.ALL_STATUSES)) {
      return filterForAllStatues;
    } else {
      return filterForOnlyNotIgnored;
    }
  }


  /**
   *
   * Section: Retrieving Diffs (parity with GitRepository)
   *
   */

  getDiffStats(filePath: ?NuclideUri): {added: number; deleted: number;} {
    const cleanStats = {added: 0, deleted: 0};
    if (!filePath) {
      return cleanStats;
    }
    const cachedData = this._hgDiffCache[filePath];
    return cachedData ? {added: cachedData.added, deleted: cachedData.deleted} :
        cleanStats;
  }

  /**
   * Returns an array of LineDiff that describes the diffs between the given
   * file's `HEAD` contents and its current contents.
   * NOTE: this method currently ignores the passed-in text, and instead diffs
   * against the currently saved contents of the file.
   */
  // TODO (jessicalin) Export the LineDiff type (from hg-output-helpers) when
  // types can be exported.
  // TODO (jessicalin) Make this method work with the passed-in `text`. t6391579
  getLineDiffs(filePath: ?NuclideUri, text: ?string): Array<LineDiff> {
    if (!filePath) {
      return [];
    }
    const diffInfo = this._hgDiffCache[filePath];
    return diffInfo ? diffInfo.lineDiffs : [];
  }


  /**
   *
   * Section: Retrieving Diffs (async methods)
   *
   */

  /**
   * Recommended method to use to get the diff stats of files in this repo.
   * @param path The file path to get the status for. If a path is not in the
   *   project, default "clean" stats will be returned.
   */
  async getDiffStatsForPath(filePath: NuclideUri): Promise<{added: number; deleted: number;}> {
    const cleanStats = {added: 0, deleted: 0};
    if (!filePath) {
      return cleanStats;
    }

    // Check the cache.
    const cachedDiffInfo = this._hgDiffCache[filePath];
    if (cachedDiffInfo) {
      return {added: cachedDiffInfo.added, deleted: cachedDiffInfo.deleted};
    }

    // Fall back to a fetch.
    const fetchedPathToDiffInfo = await this._updateDiffInfo([filePath]);
    if (fetchedPathToDiffInfo && fetchedPathToDiffInfo.get(filePath)) {
      const diffInfo = fetchedPathToDiffInfo.get(filePath);
      return {added: diffInfo.added, deleted: diffInfo.deleted};
    }

    return cleanStats;
  }

  /**
   * Recommended method to use to get the line diffs of files in this repo.
   * @param path The absolute file path to get the line diffs for. If the path \
   *   is not in the project, an empty Array will be returned.
   */
  async getLineDiffsForPath(filePath: NuclideUri): Promise<Array<LineDiff>> {
    const lineDiffs = [];
    if (!filePath) {
      return lineDiffs;
    }

    // Check the cache.
    const cachedDiffInfo = this._hgDiffCache[filePath];
    if (cachedDiffInfo) {
      return cachedDiffInfo.lineDiffs;
    }

    // Fall back to a fetch.
    const fetchedPathToDiffInfo = await this._updateDiffInfo([filePath]);
    if (fetchedPathToDiffInfo && fetchedPathToDiffInfo.get(filePath)) {
      return fetchedPathToDiffInfo.get(filePath).lineDiffs;
    }

    return lineDiffs;
  }

  /**
   * Updates the diff information for the given paths, and updates the cache.
   * @param An array of absolute file paths for which to update the diff info.
   * @return A map of each path to its DiffInfo.
   *   This method may return `null` if the call to `hg diff` fails.
   *   A file path will not appear in the returned Map if it is not in the repo,
   *   if it has no changes, or if there is a pending `hg diff` call for it already.
   */
  async _updateDiffInfo(filePaths: Array<NuclideUri>): Promise<?Map<NuclideUri, DiffInfo>> {
    const pathsToFetch = filePaths.filter((aPath) => {
      // Don't try to fetch information for this path if it's not in the repo.
      if (!this._isPathRelevant(aPath)) {
        return false;
      }
      // Don't do another update for this path if we are in the middle of running an update.
      if (this._hgDiffCacheFilesUpdating.has(aPath)) {
        return false;
      } else {
        this._hgDiffCacheFilesUpdating.add(aPath);
        return true;
      }
    });

    if (pathsToFetch.length === 0) {
      return new Map();
    }

    // Call the HgService and update our cache with the results.
    const pathsToDiffInfo = await this._service.fetchDiffInfo(pathsToFetch);
    if (pathsToDiffInfo) {
      for (const [filePath, diffInfo] of pathsToDiffInfo) {
        this._hgDiffCache[filePath] = diffInfo;
      }
    }

    // Remove files marked for deletion.
    this._hgDiffCacheFilesToClear.forEach((fileToClear) => {
      delete this._hgDiffCache[fileToClear];
    });
    this._hgDiffCacheFilesToClear.clear();

    // The fetched files can now be updated again.
    for (const pathToFetch of pathsToFetch) {
      this._hgDiffCacheFilesUpdating.delete(pathToFetch);
    }

    // TODO (t9113913) Ideally, we could send more targeted events that better
    // describe what change has occurred. Right now, GitRepository dictates either
    // 'did-change-status' or 'did-change-statuses'.
    this._emitter.emit('did-change-statuses');
    return pathsToDiffInfo;
  }


  /**
   *
   * Section: Retrieving Bookmark (async methods)
   *
   */
  async fetchCurrentBookmark(): Promise<string> {
    let newlyFetchedBookmark = '';
    try {
      newlyFetchedBookmark = await this._service.fetchCurrentBookmark();
    } catch (e) {
      // Suppress the error. There are legitimate times when there may be no
      // current bookmark, such as during a rebase. In this case, we just want
      // to return an empty string if there is no current bookmark.
    }
    if (newlyFetchedBookmark !== this._currentBookmark) {
      this._currentBookmark = newlyFetchedBookmark;
      // The Atom status-bar uses this as a signal to refresh the 'shortHead'.
      // There is currently no dedicated 'shortHeadDidChange' event.
      this._emitter.emit('did-change-statuses');
    }
    return this._currentBookmark || '';
  }


  /**
   *
   * Section: Checking Out
   *
   */

  // TODO This is a stub.
  checkoutHead(path: string): boolean {
    return false;
  }

  // TODO This is a stub.
  checkoutReference(reference: string, create: boolean): boolean {
    return false;
  }

  /**
   * This is the async version of what checkoutReference() is meant to do.
   */
  async checkoutRevision(reference: string, create: boolean): Promise<boolean> {
    return await this._service.checkout(reference, create);
  }


  /**
   *
   * Section: HgService subscriptions
   *
   */

  /**
   * Updates the cache in response to any number of (non-.hgignore) files changing.
   * @param update The changed file paths.
   */
  _filesDidChange(changedPaths: Array<NuclideUri>): void {
    const relevantChangedPaths = changedPaths.filter(this._isPathRelevant.bind(this));
    if (relevantChangedPaths.length === 0) {
      return;
    } else if (relevantChangedPaths.length <= MAX_INDIVIDUAL_CHANGED_PATHS) {
      // Update the statuses individually.
      this._updateStatuses(relevantChangedPaths, {hgStatusOption: HgStatusOption.ALL_STATUSES});
      this._updateDiffInfo(relevantChangedPaths.filter(filePath => this._hgDiffCache[filePath]));
    } else {
      // This is a heuristic to improve performance. Many files being changed may
      // be a sign that we are picking up changes that were created in an automated
      // way -- so in addition, there may be many batches of changes in succession.
      // _refreshStatusesOfAllFilesInCache debounces calls, so it is safe to call
      // it multiple times in succession.
      this._refreshStatusesOfAllFilesInCache();
    }
  }

  _refreshStatusesOfAllFilesInCache(): void {
    let debouncedRefreshAll = this._debouncedRefreshAll;
    if (debouncedRefreshAll == null) {
      const doRefresh = async () => {
        if (this._isRefreshingAllFilesInCache) {
          return;
        }
        this._isRefreshingAllFilesInCache = true;

        const pathsInStatusCache = Object.keys(this._hgStatusCache);
        this._hgStatusCache = {};
        this._modifiedDirectoryCache = new Map();
        // We should get the modified status of all files in the repo that is
        // under the HgRepositoryClient's project directory, because when Hg
        // modifies the repo, it doesn't necessarily only modify files that were
        // previously modified.
        this._updateStatuses(
            [this.getProjectDirectory()], {hgStatusOption: HgStatusOption.ONLY_NON_IGNORED});
        if (pathsInStatusCache.length) {
          // The logic is a bit different for ignored files, because the
          // HgRepositoryClient always fetches ignored statuses lazily (as callers
          // ask for them). So, we only fetch the ignored status of files already
          // in the cache. (Note: if I ask Hg for the 'ignored' status of a list of
          // files, and none of them are ignored, no statuses will be returned.)
          await this._updateStatuses(
              pathsInStatusCache, {hgStatusOption: HgStatusOption.ONLY_IGNORED});
        }

        const pathsInDiffCache = Object.keys(this._hgDiffCache);
        this._hgDiffCache = {};
        await this._updateDiffInfo(pathsInDiffCache);

        this._isRefreshingAllFilesInCache = false;
      };
      this._debouncedRefreshAll = debounce(
        doRefresh,
        DEBOUNCE_MILLISECONDS_FOR_REFRESH_ALL,
        /* immediate */ false
      );
      debouncedRefreshAll = this._debouncedRefreshAll;
    }
    debouncedRefreshAll();
  }


  /**
   *
   * Section: Repository State at Specific Revisions
   *
   */
  fetchFileContentAtRevision(filePath: NuclideUri, revision: ?string): Promise<?string> {
    return this._service.fetchFileContentAtRevision(filePath, revision);
  }

  fetchFilesChangedAtRevision(revision: string): Promise<?RevisionFileChanges> {
    return this._service.fetchFilesChangedAtRevision(revision);
  }

  fetchRevisionInfoBetweenHeadAndBase(): Promise<?Array<RevisionInfo>> {
    return this._service.fetchRevisionInfoBetweenHeadAndBase();
  }

  // See HgService.getBlameAtHead.
  getBlameAtHead(filePath: NuclideUri): Promise<Map<string, string>> {
    return this._service.getBlameAtHead(filePath);
  }

  // See HgService.getDifferentialRevisionForChangeSetId.
  getDifferentialRevisionForChangeSetId(changeSetId: string): Promise<?string> {
    return this._service.getDifferentialRevisionForChangeSetId(changeSetId);
  }

  getSmartlog(ttyOutput: boolean, concise: boolean): Promise<Object> {
    return this._service.getSmartlog(ttyOutput, concise);
  }
}
