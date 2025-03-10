import type { PromiseFsClient } from 'isomorphic-git';
import path from 'path';
import YAML from 'yaml';

import { database as db } from '../../common/database';
import type { BaseModel } from '../../models';
import * as models from '../../models';
import { isWorkspace } from '../../models/workspace';
import { resetKeys } from '../ignore-keys';
import { GIT_INSOMNIA_DIR_NAME } from './git-vcs';
import parseGitPath from './parse-git-path';
import Stat from './stat';
import { SystemError } from './system-error';

/**
 * A fs client to access workspace data stored in NeDB as files.
 * Used by isomorphic-git
 * https://isomorphic-git.org/docs/en/fs#implementing-your-own-fs
 */
export class NeDBClient {
  _workspaceId: string;
  _projectId: string;

  constructor(workspaceId: string, projectId: string) {
    if (!workspaceId) {
      throw new Error('Cannot use NeDBClient without workspace ID');
    }

    this._workspaceId = workspaceId;
    this._projectId = projectId;

  }

  static createClient(workspaceId: string, projectId: string): PromiseFsClient {
    return {
      promises: new NeDBClient(workspaceId, projectId),
    };
  }

  async readFile(
    filePath: string,
    options?: BufferEncoding | { encoding?: BufferEncoding },
  ) {
    filePath = path.normalize(filePath);
    options = options || {};

    if (typeof options === 'string') {
      options = {
        encoding: options,
      };
    }

    const { root, type, id } = parseGitPath(filePath);

    if (root === null || id === null || type === null) {
      throw this._errMissing(filePath);
    }

    const doc = await db.get(type, id);

    if (!doc || doc.isPrivate) {
      throw this._errMissing(filePath);
    }

    // When git is reading from NeDb, reset keys we wish to ignore to their original values
    resetKeys(doc);

    // It would be nice to be able to add this check here but we can't since
    // isomorphic-git may have just deleted the workspace from the FS. This
    // happens frequently during branch checkouts and merges
    //
    // if (doc.type !== models.workspace.type) {
    //   const ancestors = await db.withAncestors(doc);
    //   if (!ancestors.find(isWorkspace)) {
    //     throw new Error(`Not found under workspace ${filePath}`);
    //   }
    // }
    const raw = Buffer.from(YAML.stringify(doc), 'utf8');

    if (options.encoding) {
      return raw.toString(options.encoding);
    } else {
      return raw;
    }
  }

  async writeFile(filePath: string, data: Buffer | string) {
    filePath = path.normalize(filePath);
    const { root, id, type } = parseGitPath(filePath);

    if (root !== GIT_INSOMNIA_DIR_NAME) {
      console.log(`[git] Ignoring external file ${filePath}`);
      return;
    }

    const dataStr = data.toString();

    // Skip the file if there is a conflict marker
    if (dataStr.split('\n').includes('=======')) {
      return;
    }

    const doc: BaseModel = YAML.parse(dataStr);

    if (id !== doc._id) {
      throw new Error(`Doc _id does not match file path [${doc._id} != ${id || 'null'}]`);
    }

    if (type !== doc.type) {
      throw new Error(`Doc type does not match file path [${doc.type} != ${type || 'null'}]`);
    }

    if (isWorkspace(doc)) {
      console.log('[git] setting workspace parent to be that of the active project', { original: doc.parentId, new: this._projectId });
      // Whenever we write a workspace into nedb we should set the parentId to be that of the current project
      // This is because the parentId (or a project) is not synced into git, so it will be cleared whenever git writes the workspace into the db, thereby removing it from the project on the client
      // In order to reproduce this bug, comment out the following line, then clone a repository into a local project, then open the workspace, you'll notice it will have moved into the default project
      doc.parentId = this._projectId;
    }

    await db.upsert(doc, true);
  }

  async unlink(filePath: string) {
    filePath = path.normalize(filePath);
    const { id, type } = parseGitPath(filePath);

    if (!id || !type) {
      throw new Error(`Cannot unlink file ${filePath}`);
    }

    const doc = await db.get(type, id);

    if (!doc) {
      return;
    }

    await db.unsafeRemove(doc, true);
  }

  // recurses over each .insomnia subfolder, ApiSpec, Workspace, Request etc..
  // and returns a list of all the files/folders which should be in the directory
  // according to the what entities are children of the workspace
  async readdir(filePath: string) {
    filePath = path.normalize(filePath);
    const { root, type, id } = parseGitPath(filePath);
    let docs: BaseModel[] = [];
    let otherFolders: string[] = [];

    if (root === null && id === null && type === null) {
      otherFolders = [GIT_INSOMNIA_DIR_NAME];
    } else if (id === null && type === null) {
      // TODO: It doesn't scale if we add another model which can be sync in the future
      otherFolders = [
        models.workspace.type,
        models.environment.type,
        models.requestGroup.type,
        models.request.type,
        models.apiSpec.type,
        models.unitTestSuite.type,
        models.unitTest.type,
        models.grpcRequest.type,
        models.protoFile.type,
        models.protoDirectory.type,
        models.webSocketRequest.type,
        models.webSocketPayload.type,
        models.mockRoute.type,
        models.mockServer.type,
      ];
    } else if (type !== null && id === null) {
      const workspace = await db.get(models.workspace.type, this._workspaceId);
      let typeFilter = [type];

      const modelTypesWithinFolders = [models.request.type, models.grpcRequest.type, models.webSocketRequest.type];
      if (modelTypesWithinFolders.includes(type)) {
        typeFilter = [models.requestGroup.type, type];
      };

      if (type === models.unitTest.type) {
        typeFilter = [models.unitTestSuite.type, type];
      }

      if (type === models.protoFile.type) {
        typeFilter = [models.protoDirectory.type, type];
      }

      if (type === models.mockRoute.type) {
        typeFilter = [models.mockServer.type, type];
      }

      if (type === models.webSocketPayload.type) {
        typeFilter = [models.webSocketRequest.type, type];
      }

      const children = await db.withDescendants(workspace, null, typeFilter);
      docs = children.filter(d => d.type === type && !d.isPrivate);
    } else {
      throw this._errMissing(filePath);
    }

    const ids = docs.map(d => `${d._id}.yml`);
    return [...ids, ...otherFolders].sort();
  }

  async mkdir() {
    throw new Error('NeDBClient is not writable');
  }

  async stat(filePath: string) {
    filePath = path.normalize(filePath);
    let fileBuff: Buffer | string | null = null;
    let dir: string[] | null = null;

    try {
      fileBuff = await this.readFile(filePath);
    } catch (err) {
      // console.log('[nedb] Failed to read file', err);
    }

    if (fileBuff === null) {
      try {
        dir = await this.readdir(filePath);
      } catch (err) {
        // console.log('[nedb] Failed to read dir', err);
      }
    }

    if (!fileBuff && !dir) {
      throw this._errMissing(filePath);
    }

    if (fileBuff) {
      const doc: BaseModel = YAML.parse(fileBuff.toString());
      return new Stat({
        type: 'file',
        mode: 0o777,
        size: fileBuff.length,
        // @ts-expect-error should be number instead of string https://nodejs.org/api/fs.html#fs_stats_ino
        ino: doc._id,
        mtimeMs: doc.modified,
      });
    } else {
      return new Stat({
        type: 'dir',
        mode: 0o777,
        size: 0,
        ino: 0,
        mtimeMs: 0,
      });
    }
  }

  async readlink(filePath: string, ...x: any[]) {
    return this.readFile(filePath, ...x);
  }

  async lstat(filePath: string) {
    return this.stat(filePath);
  }

  async rmdir() {
    // Dirs in NeDB can't be removed, so we'll just pretend like it succeeded
    return Promise.resolve();
  }

  async symlink() {
    throw new Error('NeDBClient symlink not supported');
  }

  _errMissing(filePath: string) {
    return new SystemError({
      message: `ENOENT: no such file or directory, scandir '${filePath}'`,
      errno: -2,
      code: 'ENOENT',
      syscall: 'scandir',
      path: filePath,
    });
  }
}
