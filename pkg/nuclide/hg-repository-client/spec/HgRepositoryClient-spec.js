'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {HgService as HgServiceType} from 'nuclide-hg-repository-base/lib/HgService.js';

import {Directory} from 'atom';
import
  HgRepositoryClient,
  {DEBOUNCE_MILLISECONDS_FOR_REFRESH_ALL, MAX_INDIVIDUAL_CHANGED_PATHS,}
from '../lib/HgRepositoryClient';
import MockHgService from 'nuclide-hg-repository-base/spec/MockHgService';
import {
  HgStatusOption,
  StatusCodeId,
  StatusCodeNumber,
} from 'nuclide-hg-repository-base/lib/hg-constants';
import path from 'path';
import temp from 'temp';
const tempWithAutoCleanup = temp.track();


describe('HgRepositoryClient', () => {
  const tempDir = tempWithAutoCleanup.mkdirSync('testproj');
  const tempSubDir = tempWithAutoCleanup.mkdirSync({dir: tempDir});

  const repoPath = path.join(tempDir, '.hg');
  const workingDirectory = new Directory(tempDir);
  const projectDirectory = new Directory(tempSubDir);
  const repoOptions = {
    originURL: 'http://test.com/testproj',
    workingDirectory,
    projectRootDirectory: projectDirectory,
  };

  // Manufactures the absolute path of a file that should pass as being
  // within the repo.
  const createFilePath = (filename) => {
    return path.join(projectDirectory.getPath(), filename);
  };

  // Some test "absolute" paths.
  const PATH_1 = createFilePath('test1.js');
  const PATH_2 = createFilePath('test2.js');
  const PATH_3 = createFilePath('test3.js');
  const PATH_4 = createFilePath('test4.js');
  const PATH_5 = createFilePath('test5.js');
  const PATH_6 = createFilePath('test6.js');
  const PATH_7 = createFilePath('test7.js');
  const PATH_CALLED_NULL = createFilePath('null');
  const PATH_CALLED_UNDEFINED = createFilePath('undefined');

  let mockHgService: HgServiceType = (null: any);
  let repo: HgRepositoryClient = (null: any);

  beforeEach(() => {
    mockHgService = ((new MockHgService(): any): HgServiceType);
    repo = new HgRepositoryClient(repoPath, mockHgService, repoOptions);
  });

  describe('::getType()', () => {
    it('returns "hg"', () => {
      expect(repo.getType()).toBe('hg');
    });
  });

  describe('::getProjectDirectory', () => {
    it('returns the path of the root project folder in Atom that this Client provides information about.', () => {
      expect(repo.getProjectDirectory()).toBe(projectDirectory.getPath());
    });
  });

  describe('::getStatuses', () => {
    beforeEach(() => {
      // Test setup: Mock out the dependency on HgRepository::_updateStatuses, and set up the cache state.
      // $FlowIssue computed properties (t6187050)
      const mockFetchedStatuses = {[PATH_1]: StatusCodeId.ADDED};
      spyOn(repo, '_updateStatuses').andCallFake((paths, options) => {
        const statuses = new Map();
        paths.forEach((filePath) => {
          statuses.set(filePath, mockFetchedStatuses[filePath]);
        });
        return Promise.resolve(statuses);
      });
      repo._hgStatusCache = {
        // $FlowIssue computed properties (t6187050)
        [PATH_2]: StatusCodeId.IGNORED,
        // $FlowIssue computed properties (t6187050)
        [PATH_3]: StatusCodeId.MODIFIED,
      };
    });

    it('returns statuses from the cache when possible, and only fetches the status for cache misses.', () => {
      const hgStatusOptions = {hgStatusOption: HgStatusOption.ALL_STATUSES};
      waitsForPromise(async () => {
        const statusMap = await repo.getStatuses([PATH_1, PATH_2], hgStatusOptions);
        expect(repo._updateStatuses).toHaveBeenCalledWith([PATH_1], hgStatusOptions);
        expect(statusMap).toEqual(new Map([
          [PATH_1, StatusCodeNumber.ADDED],
          [PATH_2, StatusCodeNumber.IGNORED],
        ]));
      });
    });

    it('when reading from the cache, it respects the hgStatusOption.', () => {
      waitsForPromise(async () => {
        const statusMap = await repo.getStatuses(
            [PATH_2, PATH_3], {hgStatusOption: HgStatusOption.ONLY_NON_IGNORED});
        expect(repo._updateStatuses).not.toHaveBeenCalled();
        expect(statusMap).toEqual(new Map([
          [PATH_3, StatusCodeNumber.MODIFIED],
        ]));
      });

      waitsForPromise(async () => {
        const statusMap = await repo.getStatuses(
            [PATH_2, PATH_3], {hgStatusOption: HgStatusOption.ONLY_IGNORED});
        expect(repo._updateStatuses).not.toHaveBeenCalled();
        expect(statusMap).toEqual(new Map([
          [PATH_2, StatusCodeNumber.IGNORED],
        ]));
      });
    });
  });

  describe('::_updateStatuses', () => {
    const nonIgnoredOption = {hgStatusOption: HgStatusOption.ONLY_NON_IGNORED};
    const onlyIgnoredOption = {hgStatusOption: HgStatusOption.ONLY_IGNORED};
    const mockHgStatusFetchData = new Map([
      [PATH_1, StatusCodeId.ADDED],
      [PATH_2, StatusCodeId.UNTRACKED],
      [PATH_3, StatusCodeId.CLEAN],
      [PATH_6, StatusCodeId.CLEAN],
      [PATH_7, StatusCodeId.MODIFIED],
    ]);
    let mockOldCacheState;

    beforeEach(() => {
      mockOldCacheState = {
        // $FlowIssue computed properties (t6187050)
        [PATH_1]: StatusCodeId.IGNORED,
        // $FlowIssue computed properties (t6187050)
        [PATH_2]: StatusCodeId.UNTRACKED,
        // $FlowIssue computed properties (t6187050)
        [PATH_3]: StatusCodeId.MODIFIED,
        // $FlowIssue computed properties (t6187050)
        [PATH_4]: StatusCodeId.IGNORED,
        // $FlowIssue computed properties (t6187050)
        [PATH_5]: StatusCodeId.MODIFIED,
      };

      spyOn(repo._service, 'fetchStatuses').andCallFake((paths, options) => {
        const statusMap = new Map();
        paths.forEach((filePath) => {
          const fetchedStatus = mockHgStatusFetchData.get(filePath);
          if (fetchedStatus) {
            statusMap.set(filePath, fetchedStatus);
          }
        });
        return Promise.resolve(statusMap);
      });
      repo._hgStatusCache = {};
      Object.keys(mockOldCacheState).forEach((filePath) => {
        // $FlowIssue computed properties (t6187050)
        repo._hgStatusCache[filePath] = mockOldCacheState[filePath];
      });
      // Make it so all of the test paths are deemed within the repo.
      spyOn(workingDirectory, 'contains').andCallFake(() => {
        return true;
      });
    });

    it('does a fresh fetch for the hg status for all paths it is passed, and returns them.', () => {
      const paths = [PATH_1, PATH_2];
      waitsForPromise(async () => {
        const output = await repo._updateStatuses(paths, nonIgnoredOption);
        expect(repo._service.fetchStatuses).toHaveBeenCalledWith(paths, nonIgnoredOption);
        const expectedStatus = new Map([
          [PATH_1, mockHgStatusFetchData.get(PATH_1)],
          [PATH_2, mockHgStatusFetchData.get(PATH_2)],
        ]);
        expect(output).toEqual(expectedStatus);
      });
    });

    describe(`it removes a path from the cache if the fetch indicates its status is unknown but incorrect in the cache,
        as informed by the hgStatusOption passed in`, () => {
      const pathsWithNoStatusReturned = [PATH_4, PATH_5];

      it('Case 1: HgStatusOption.ONLY_NON_IGNORED', () => {
        waitsForPromise(async () => {
          await repo._updateStatuses(pathsWithNoStatusReturned, nonIgnoredOption);
          // PATH_4 was queried for but not returned, but the fetch was for non-ignored files.
          //   We have no evidence that its status is out of date, so it should remain 'ignored' in the cache.
          // PATH_5 was queried for but not returned, and the fetch was for non-ignored files.
          //   This means its state is no longer 'modified', as it was listed in the cache.
          expect(repo._hgStatusCache[PATH_4]).toBe(StatusCodeId.IGNORED);
          expect(repo._hgStatusCache[PATH_5]).toBeUndefined();
        });
      });

      it('Case 2: HgStatusOption.ONLY_IGNORED', () => {
        waitsForPromise(async () => {
          await repo._updateStatuses(pathsWithNoStatusReturned, onlyIgnoredOption);
          // PATH_5 was queried for but not returned, but the fetch was for ignored files.
          //   We have no evidence that its status is out of date, so it should remain 'modified' in the cache.
          // PATH_4 was queried for but not returned, and the fetch was for ignored files.
          //   This means its state is no longer 'ignored', as it was listed in the cache.
          expect(repo._hgStatusCache[PATH_5]).toBe(StatusCodeId.MODIFIED);
          expect(repo._hgStatusCache[PATH_4]).toBeUndefined();
        });
      });
    });

    it ('does not add "clean" files to the cache and removes them if they are in the cache.', () => {
      const pathsWithCleanStatusReturned = [PATH_3, PATH_6];
      waitsForPromise(async () => {
        await repo._updateStatuses(pathsWithCleanStatusReturned, {hgStatusOption: HgStatusOption.ALL_STATUSES});
        // PATH_3 was previously in the cache. PATH_6 was never in the cache.
        expect(repo._hgStatusCache[PATH_3]).toBeUndefined();
        expect(repo._hgStatusCache[PATH_6]).toBeUndefined();
      });
    });

    it('triggers the callbacks registered through ::onDidChangeStatuses and ::onDidChangeStatus.', () => {
      const callbackSpyForStatuses = jasmine.createSpy('::onDidChangeStatuses spy');
      repo.onDidChangeStatuses(callbackSpyForStatuses);
      const callbackSpyForStatus = jasmine.createSpy('::onDidChangeStatus spy');
      repo.onDidChangeStatus(callbackSpyForStatus);

      // File existed in the cache, and its status changed.
      const expectedChangeEvent1 = {
        path: PATH_1,
        pathStatus: StatusCodeNumber.ADDED,
      };

      // File did not exist in the cache, and its status is modified.
      const expectedChangeEvent2 = {
        path: PATH_7,
        pathStatus: StatusCodeNumber.MODIFIED,
      };

      waitsForPromise(async () => {
        // We must pass in the updated filenames to catch the case when a cached status turns to 'clean'.
        await repo._updateStatuses([PATH_1, PATH_2, PATH_6, PATH_7], {hgStatusOption: HgStatusOption.ALL_STATUSES});
        expect(callbackSpyForStatuses.calls.length).toBe(1);
        expect(callbackSpyForStatus.calls.length).toBe(2);
        // PATH_2 existed in the cache, and its status did not change, so it shouldn't generate an event.
        // PATH_6 did not exist in the cache, but its status is clean, so it shouldn't generate an event.
        expect(callbackSpyForStatus).toHaveBeenCalledWith(expectedChangeEvent1);
        expect(callbackSpyForStatus).toHaveBeenCalledWith(expectedChangeEvent2);
      });
    });
  });

  describe('::_filesDidChange', () => {
    it(
      'triggers a full refresh of the state of the Hg statuses if there are more than ' +
      'MAX_INDIVIDUAL_CHANGED_PATHS paths changed within the project directory.',
      () => {
        const mockUpdate = [PATH_1, PATH_2];
        // This test is only valid if the number of relevant files in the update
        // > MAX_INDIVIDUAL_CHANGED_PATHS. If MAX_INDIVIDUAL_CHANGED_PATHS changes,
        // this test needs to be updated.
        expect(mockUpdate.length).toBeGreaterThan(MAX_INDIVIDUAL_CHANGED_PATHS);
        spyOn(repo, '_updateStatuses');

        waitsForPromise(async () => {
          await repo._filesDidChange(mockUpdate);
          setTimeout(() => {
            expect(repo._updateStatuses).toHaveBeenCalledWith(
                [repo.getProjectDirectory()], {hgStatusOption: HgStatusOption.ONLY_NON_IGNORED});
          }, DEBOUNCE_MILLISECONDS_FOR_REFRESH_ALL + 50);
        });
      }
    );

    it(
      'triggers an update for the state of the Hg statuses of individual files if there ' +
      'are <= MAX_INDIVIDUAL_CHANGED_PATHS paths changed within the project directory.',
      () => {
        const mockUpdate = [PATH_1];
        // This test is only valid if the number of relevant files in the update
        // <= MAX_INDIVIDUAL_CHANGED_PATHS. If MAX_INDIVIDUAL_CHANGED_PATHS changes,
        // this test needs to be updated.
        expect(mockUpdate.length).not.toBeGreaterThan(MAX_INDIVIDUAL_CHANGED_PATHS);
        spyOn(repo, '_updateStatuses');

        waitsForPromise(async () => {
          await repo._filesDidChange(mockUpdate);
          setTimeout(() => {
            expect(repo._updateStatuses).toHaveBeenCalled(
              [PATH_1],
              {hgStatusOption: HgStatusOption.ALL_STATUSES},
            );
            expect(repo._updateStatuses).not.toHaveBeenCalledWith(
              [repo.getProjectDirectory()],
              {hgStatusOption: HgStatusOption.ONLY_NON_IGNORED},
            );
          }, DEBOUNCE_MILLISECONDS_FOR_REFRESH_ALL + 50);
        });
      }
    );

    it(
      'does not triggers a full refresh of the state of the Hg statuses if none of ' +
      'the changed paths are within the project directory.', () => {
      const path_not_in_project = '/Random/Path';
      const mockUpdate = [path_not_in_project];
      spyOn(repo, '_updateStatuses');

      waitsForPromise(async () => {
        await repo._filesDidChange(mockUpdate);
        setTimeout(() => {
          expect(repo._updateStatuses).not.toHaveBeenCalledWith(
                [repo.getProjectDirectory()], {hgStatusOption: HgStatusOption.ONLY_NON_IGNORED});
        }, DEBOUNCE_MILLISECONDS_FOR_REFRESH_ALL + 50);
      });
    }
    );
  });

  describe('_refreshStatusesOfAllFilesInCache', () => {
    it('refreshes the status of all paths currently in the cache after a debounce ' +
        'interval.', () => {
      // Test setup: force the state of the repo.
      const testRepoState = {
        // $FlowIssue computed properties (t6187050)
        [PATH_1]: StatusCodeId.IGNORED,
        // $FlowIssue computed properties (t6187050)
        [PATH_2]: StatusCodeId.MODIFIED,
        // $FlowIssue computed properties (t6187050)
        [PATH_3]: StatusCodeId.ADDED,
      };
      repo._hgStatusCache = testRepoState;
      spyOn(repo, '_updateStatuses').andCallFake((filePaths, options) => {
        // The cache should be cleared before being fully refreshed.
        expect(repo._hgStatusCache).toEqual({});
      });

      repo._refreshStatusesOfAllFilesInCache();
      setTimeout(() => {
        expect(repo._updateStatuses).toHaveBeenCalledWith(
          Object.keys(testRepoState),
          {hgStatusOption: HgStatusOption.ALL_STATUSES}
        );
      }, DEBOUNCE_MILLISECONDS_FOR_REFRESH_ALL + 50);
    });
  });

  describe('::isPathIgnored', () => {
    it('returns true if the path is marked ignored in the cache.', () => {
      // Force the state of the cache.
      repo._hgStatusCache = {
        // $FlowIssue computed properties (t6187050)
        [PATH_1]: StatusCodeId.IGNORED,
      };
      expect(repo.isPathIgnored(PATH_1)).toBe(true);
    });

    it('returns true if the path is, or is within, the .hg directory.', () => {
      expect(repo.isPathIgnored(repoPath)).toBe(true);
      expect(repo.isPathIgnored(path.join(repoPath, 'blah'))).toBe(true);
    });

    it('returns false if the path is not in the cache and is not the .hg directory.', () => {
      expect(repo.isPathIgnored('/A/Random/Path')).toBe(false);
      const parsedPath = path.parse(repoPath);
      expect(repo.isPathIgnored(parsedPath.root)).toBe(false);
      expect(repo.isPathIgnored(parsedPath.dir)).toBe(false);
    });

    it('returns false if the path is null or undefined, but handles files with those names.', () => {
      // Force the state of the cache.
      repo._hgStatusCache = {
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_NULL]: StatusCodeId.IGNORED,
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_UNDEFINED]: StatusCodeId.IGNORED,
      };
      expect(repo.isPathIgnored(null)).toBe(false);
      expect(repo.isPathIgnored(undefined)).toBe(false);
      expect(repo.isPathIgnored(PATH_CALLED_NULL)).toBe(true);
      expect(repo.isPathIgnored(PATH_CALLED_UNDEFINED)).toBe(true);
    });
  });

  describe('::isPathNew', () => {
    it('returns false if the path is null or undefined, but handles files with those names.', () => {
      // Force the state of the cache.
      repo._hgStatusCache = {
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_NULL]: StatusCodeId.ADDED,
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_UNDEFINED]: StatusCodeId.ADDED,
      };
      expect(repo.isPathNew(null)).toBe(false);
      expect(repo.isPathNew(undefined)).toBe(false);
      expect(repo.isPathNew(PATH_CALLED_NULL)).toBe(true);
      expect(repo.isPathNew(PATH_CALLED_UNDEFINED)).toBe(true);
    });
  });

  describe('::isPathModified', () => {
    it('returns false if the path is null or undefined, but handles files with those names.', () => {
      // Force the state of the cache.
      repo._hgStatusCache = {
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_NULL]: StatusCodeId.MODIFIED,
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_UNDEFINED]: StatusCodeId.MODIFIED,
      };
      expect(repo.isPathModified(null)).toBe(false);
      expect(repo.isPathModified(undefined)).toBe(false);
      expect(repo.isPathModified(PATH_CALLED_NULL)).toBe(true);
      expect(repo.isPathModified(PATH_CALLED_UNDEFINED)).toBe(true);
    });
  });

  describe('::getCachedPathStatus', () => {
    beforeEach(() => {
      repo._hgStatusCache = {
        // $FlowIssue computed properties (t6187050)
        [PATH_1]: StatusCodeId.MODIFIED,
        // $FlowIssue computed properties (t6187050)
        [PATH_2]: StatusCodeId.IGNORED,
      };
    });

    it('retrieves cached hg status.', () => {
      // Force the state of the cache.
      const status = repo.getCachedPathStatus(PATH_1);
      expect(repo.isStatusModified(status)).toBe(true);
      expect(repo.isStatusNew(status)).toBe(false);
    });

    it ('retrieves cached hg ignore status.', () => {
      const status = repo.getCachedPathStatus(PATH_2);
      // The status codes have no meaning; just test the expected translated
      // meanings.
      expect(repo.isStatusModified(status)).toBe(false);
      expect(repo.isStatusNew(status)).toBe(false);
    });

    it ('returns a clean status by default.', () => {
      const status = repo.getCachedPathStatus('path-not-in-cache');
      // The status codes have no meaning; just test the expected translated
      // meanings.
      expect(repo.isStatusModified(status)).toBe(false);
      expect(repo.isStatusNew(status)).toBe(false);
    });
  });

  describe('the hgDiffCache', () => {
    beforeEach(() => {
      // Unfortunately, when the temp files in these tests are opened in the editor,
      // editor.getPath() returns the original file path with '/private/' appended
      // to it. Thus, the path returned from editor.getPath() (which is what is
      // used in HgRepository) would fail a real 'contains' method. So we override
      // this to the expected path.
      const workingDirectoryClone = new Directory(tempDir);
      spyOn(workingDirectory, 'contains').andCallFake((filePath) => {
        const prefix = '/private';
        if (filePath.startsWith(prefix)) {
          const prefixRemovedPath = filePath.slice(prefix.length);
          return workingDirectoryClone.contains(prefixRemovedPath);
        }
        return workingDirectoryClone.contains(filePath);
      });

      const projectDirectoryClone = new Directory(tempSubDir);
      spyOn(projectDirectory, 'contains').andCallFake((filePath) => {
        const prefix = '/private';
        if (filePath.startsWith(prefix)) {
          const prefixRemovedPath = filePath.slice(prefix.length);
          return projectDirectoryClone.contains(prefixRemovedPath);
        }
        return projectDirectoryClone.contains(filePath);
      });
    });

    xit('is updated when the active pane item changes to an editor, if the editor file is in the project.', () => {
      spyOn(repo, '_updateDiffInfo');
      const file = tempWithAutoCleanup.openSync({dir: projectDirectory.getPath()});
      waitsForPromise(async () => {
        const editor = await atom.workspace.open(file.path);
        expect(repo._updateDiffInfo.calls.length).toBe(1);
        expect(repo._updateDiffInfo).toHaveBeenCalledWith(editor.getPath());
      });
    });

    it('is not updated when the active pane item changes to an editor whose file is not in the repo.', () => {
      spyOn(repo, '_updateDiffInfo');
      const file = tempWithAutoCleanup.openSync();
      waitsForPromise(async () => {
        await atom.workspace.open(file.path);
        expect(repo._updateDiffInfo.calls.length).toBe(0);
      });
    });

    it('marks a file to be removed from the cache after its editor is closed, if the file is in the project.', () => {
      spyOn(repo, '_updateDiffInfo');
      const file = tempWithAutoCleanup.openSync({dir: projectDirectory.getPath()});
      waitsForPromise(async () => {
        const editor = await atom.workspace.open(file.path);
        expect(repo._hgDiffCacheFilesToClear.size).toBe(0);
        editor.destroy();
        const expectedSet = new Set([editor.getPath()]);
        expect(repo._hgDiffCacheFilesToClear).toEqual(expectedSet);
      });
    });
  });

  describe('Diff Info Getters', () => {
    let mockDiffStats;
    let mockLineDiffs;
    let mockDiffInfo;

    beforeEach(() => {
      // Test setup: Mock out the dependency on HgRepository::_updateDiffInfo,
      // and set up the cache state.
      mockDiffStats = {
        added: 2,
        deleted: 11,
      };
      mockLineDiffs = [{
        oldStart: 150,
        oldLines: 11,
        newStart: 150,
        newLines: 2,
      }];
      mockDiffInfo = {
        added: mockDiffStats.added,
        deleted: mockDiffStats.deleted,
        lineDiffs: mockLineDiffs,
      };
      // $FlowIssue computed properties (t6187050)
      const mockFetchedDiffInfo = {[PATH_1]: mockDiffInfo};
      spyOn(repo, '_updateDiffInfo').andCallFake((filePaths) => {
        const mockFetchedPathToDiffInfo = new Map();
        for (const filePath of filePaths) {
          mockFetchedPathToDiffInfo.set(filePath, mockFetchedDiffInfo[filePath]);
        }
        return Promise.resolve(mockFetchedPathToDiffInfo);
      });
      repo._hgDiffCache = {
        // $FlowIssue computed properties (t6187050)
        [PATH_2]: mockDiffInfo,
      };
    });

    describe('::getDiffStatsForPath', () => {
      it('returns diff stats from the cache when possible, and only fetches new diff info for cache misses.', () => {
        waitsForPromise(async () => {
          const diffInfo_1 = await repo.getDiffStatsForPath(PATH_1);
          expect(repo._updateDiffInfo).toHaveBeenCalledWith([PATH_1]);
          expect(diffInfo_1).toEqual(mockDiffStats);
          const diffInfo_2 = await repo.getDiffStatsForPath(PATH_2);
          expect(repo._updateDiffInfo).not.toHaveBeenCalledWith([PATH_2]);
          expect(diffInfo_2).toEqual(mockDiffStats);
        });
      });
    });

    describe('::getLineDiffsForPath', () => {
      it('returns line diffs from the cache when possible, and only fetches new diff info for cache misses.', () => {
        waitsForPromise(async () => {
          const diffInfo_1 = await repo.getLineDiffsForPath(PATH_1);
          expect(repo._updateDiffInfo).toHaveBeenCalledWith([PATH_1]);
          expect(diffInfo_1).toEqual(mockLineDiffs);
          const diffInfo_2 = await repo.getLineDiffsForPath(PATH_2);
          expect(repo._updateDiffInfo).not.toHaveBeenCalledWith([PATH_2]);
          expect(diffInfo_2).toEqual(mockLineDiffs);
        });
      });
    });
  });

  describe('::_updateDiffInfo', () => {
    const mockDiffInfo = {
      added: 2,
      deleted: 11,
      lineDiffs: [{
        oldStart: 150,
        oldLines: 11,
        newStart: 150,
        newLines: 2,
      }],
    };

    beforeEach(() => {
      spyOn(repo._service, 'fetchDiffInfo').andCallFake((filePaths) => {
        const mockFetchedPathToDiffInfo = new Map();
        for (const filePath of filePaths) {
          mockFetchedPathToDiffInfo.set(filePath, mockDiffInfo);
        }
        return Promise.resolve(mockFetchedPathToDiffInfo);
      });
      spyOn(workingDirectory, 'contains').andCallFake(() => {
        return true;
      });
    });

    it('updates the cache when the path to update is not already being updated.', () => {
      waitsForPromise(async () => {
        expect(repo._hgDiffCache[PATH_1]).toBeUndefined();
        await repo._updateDiffInfo([PATH_1]);
        expect(repo._hgDiffCache[PATH_1]).toEqual(mockDiffInfo);
      });
    });

    it('does not update the cache when the path to update is already being updated.', () => {
      waitsForPromise(async () => {
        repo._updateDiffInfo([PATH_1]);
        // This second call should not kick off a second `hg diff` call, because
        // the first one should be still running.
        repo._updateDiffInfo([PATH_1]);
        expect(repo._service.fetchDiffInfo.calls.length).toBe(1);
      });
    });

    it('removes paths that are marked for removal from the cache.', () => {
      // Set up some mock paths to be removed. One already exists in the cache,
      // the other is going to be attempted to be updated. Both should be removed.
      const testPathToRemove1 = PATH_1;
      const testPathToRemove2 = PATH_2;
      repo._hgDiffCache[testPathToRemove1] = {added: 0, deleted: 0, lineDiffs: []};
      repo._hgDiffCacheFilesToClear.add(testPathToRemove1);
      repo._hgDiffCacheFilesToClear.add(testPathToRemove2);

      waitsForPromise(async () => {
        await repo._updateDiffInfo([testPathToRemove2]);
        expect(repo._hgDiffCache[testPathToRemove1]).not.toBeDefined();
        expect(repo._hgDiffCache[testPathToRemove2]).not.toBeDefined();
      });
    });
  });

  describe('::getDirectoryStatus', () => {
    const {ensureTrailingSeparator} = require('nuclide-commons').paths;
    const testDir = createFilePath('subDirectory');
    const subDirectory = path.join(testDir, 'dir1');
    const subSubDirectory = path.join(subDirectory, 'dir2');

    it('marks a directory as modified only if it is in the modified directories cache.', () => {
      // Force the state of the hgStatusCache.
      repo._modifiedDirectoryCache = new Map();
      repo._modifiedDirectoryCache.set(ensureTrailingSeparator(testDir), 1);
      repo._modifiedDirectoryCache.set(ensureTrailingSeparator(subDirectory), 1);

      expect(repo.getDirectoryStatus(testDir)).toBe(StatusCodeNumber.MODIFIED);
      expect(repo.getDirectoryStatus(subDirectory)).toBe(StatusCodeNumber.MODIFIED);
      expect(repo.getDirectoryStatus(subSubDirectory)).toBe(StatusCodeNumber.CLEAN);
    });

    it('handles a null or undefined input "path" but handles paths with those names.', () => {
      const dir_called_null = createFilePath('null');
      const dir_called_undefined = createFilePath('undefined');

      // Force the state of the cache.
      repo._modifiedDirectoryCache = new Map();
      repo._modifiedDirectoryCache.set(ensureTrailingSeparator(dir_called_null), 1);
      repo._modifiedDirectoryCache.set(ensureTrailingSeparator(dir_called_undefined), 1);

      expect(repo.getDirectoryStatus(null)).toBe(StatusCodeNumber.CLEAN);
      expect(repo.getDirectoryStatus(undefined)).toBe(StatusCodeNumber.CLEAN);
      expect(repo.getDirectoryStatus(dir_called_null)).toBe(StatusCodeNumber.MODIFIED);
      expect(repo.getDirectoryStatus(dir_called_undefined)).toBe(StatusCodeNumber.MODIFIED);
    });
  });

  describe('::getCachedPathStatus/::getPathStatus', () => {
    it('handles a null or undefined input "path" but handles paths with those names.', () => {
      // Force the state of the cache.
      repo._hgStatusCache = {
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_NULL]: StatusCodeId.MODIFIED,
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_UNDEFINED]: StatusCodeId.MODIFIED,
      };
      expect(repo.getCachedPathStatus(null)).toBe(StatusCodeNumber.CLEAN);
      expect(repo.getCachedPathStatus(undefined)).toBe(StatusCodeNumber.CLEAN);
      expect(repo.getCachedPathStatus(PATH_CALLED_NULL)).toBe(StatusCodeNumber.MODIFIED);
      expect(repo.getCachedPathStatus(PATH_CALLED_UNDEFINED)).toBe(StatusCodeNumber.MODIFIED);
    });
  });

  describe('::isStatusModified', () => {
    it('returns false for a null or undefined input.', () => {
      expect(repo.isStatusModified(null)).toBe(false);
      expect(repo.isStatusModified(undefined)).toBe(false);
    });
  });

  describe('::isStatusNew', () => {
    it('returns false for a null or undefined input.', () => {
      expect(repo.isStatusNew(null)).toBe(false);
      expect(repo.isStatusNew(undefined)).toBe(false);
    });
  });

  describe('::getDiffStats', () => {
    it('returns clean stats if the path is null or undefined, but handles paths with those names.', () => {
      const mockDiffInfo = {
        added: 1,
        deleted: 1,
        lineDiffs: [{
          oldStart: 2,
          oldLines: 1,
          newStart: 2,
          newLines: 1,
        }],
      };
      // Force the state of the cache.
      repo._hgDiffCache = {
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_NULL]: mockDiffInfo,
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_UNDEFINED]: mockDiffInfo,
      };
      const cleanStats = {added: 0, deleted: 0};
      const expectedChangeStats = {added: 1, deleted: 1};
      expect(repo.getDiffStats(null)).toEqual(cleanStats);
      expect(repo.getDiffStats(undefined)).toEqual(cleanStats);
      expect(repo.getDiffStats(PATH_CALLED_NULL)).toEqual(expectedChangeStats);
      expect(repo.getDiffStats(PATH_CALLED_UNDEFINED)).toEqual(expectedChangeStats);
    });
  });

  describe('::getLineDiffs', () => {
    it('returns an empty array if the path is null or undefined, but handles paths with those names.', () => {
      const mockDiffInfo = {
        added: 1,
        deleted: 1,
        lineDiffs: [{
          oldStart: 2,
          oldLines: 1,
          newStart: 2,
          newLines: 1,
        }],
      };
      // Force the state of the cache.
      repo._hgDiffCache = {
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_NULL]: mockDiffInfo,
        // $FlowIssue computed properties (t6187050)
        [PATH_CALLED_UNDEFINED]: mockDiffInfo,
      };
      // For now the second argument, 'text', is not used.
      expect(repo.getLineDiffs(null, null)).toEqual([]);
      expect(repo.getLineDiffs(undefined, null)).toEqual([]);
      expect(repo.getLineDiffs(PATH_CALLED_NULL, null)).toEqual(mockDiffInfo.lineDiffs);
      expect(repo.getLineDiffs(PATH_CALLED_UNDEFINED, null)).toEqual(mockDiffInfo.lineDiffs);
    });
  });

  describe('::destroy', () => {
    it('should do cleanup without throwing an exception.', () => {
      const spy = jasmine.createSpy();
      repo.onDidDestroy(spy);
      repo.destroy();
      expect(spy).toHaveBeenCalled();
    });
  });

});
