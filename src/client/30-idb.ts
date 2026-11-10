/**
 * IndexedDB 本地工程库（库名 pulseforge / 对象仓库 projects）。
 *
 * 它只是「快速恢复」缓存：Chromium 清缓存或调用 clearStorageData 时会被清空，
 * 因此界面上始终并行提供「导出工程 JSON」作为用户可留存的备份。
 */

const IDB_NAME = 'pulseforge'
const IDB_STORE = 'projects'
const IDB_KEY = 'current'
const IDB_VERSION = 1

/** 打开数据库；首次使用时建仓库。任何失败都 reject，由调用方降级。 */
function openProjectDb(): Promise<IDBDatabase> {
  return new Promise(function (resolve, reject) {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前渲染进程不可用 IndexedDB'))
      return
    }
    const request = indexedDB.open(IDB_NAME, IDB_VERSION)
    request.onupgradeneeded = function () {
      const db = request.result
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
    }
    request.onsuccess = function () {
      resolve(request.result)
    }
    request.onerror = function () {
      reject(request.error ?? new Error('IndexedDB 打开失败'))
    }
    request.onblocked = function () {
      reject(new Error('IndexedDB 被其他标签页阻塞'))
    }
  })
}

/** 在单个事务里执行一次读写，事务结束即关闭连接，避免长期占用。 */
function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openProjectDb().then(function (db) {
    return new Promise<T>(function (resolve, reject) {
      const tx = db.transaction(IDB_STORE, mode)
      const store = tx.objectStore(IDB_STORE)
      let request: IDBRequest<T>
      try {
        request = work(store)
      } catch (error) {
        db.close()
        reject(error)
        return
      }
      request.onsuccess = function () {
        resolve(request.result)
      }
      request.onerror = function () {
        reject(request.error ?? new Error('IndexedDB 请求失败'))
      }
      tx.oncomplete = function () {
        db.close()
      }
      tx.onabort = function () {
        db.close()
        reject(tx.error ?? new Error('IndexedDB 事务被中断'))
      }
    })
  })
}

/** 写入当前工程快照。 */
function saveProjectRecord(project: ProjectFile): Promise<void> {
  const record = { key: IDB_KEY, savedAt: new Date().toISOString(), project: project }
  return withStore('readwrite', function (store) {
    return store.put(record, IDB_KEY)
  }).then(function () {
    return undefined
  })
}

/** 读取上次工程；没有记录时返回 null。 */
function loadProjectRecord(): Promise<unknown> {
  return withStore('readonly', function (store) {
    return store.get(IDB_KEY)
  }).then(function (record) {
    if (record === undefined || record === null) return null
    const holder = record as { project?: unknown }
    return holder.project ?? null
  })
}
