
var assert = require('assert')
var Transform = require('readable-stream').Transform
var Q = require('q')
var typeforce = require('typeforce')
var utils = require('tradle-utils')
var debug = require('debug')('chainloader')
var inherits = require('util').inherits
var extend = require('extend')
var txd = require('tradle-tx-data')
var TxInfo = txd.TxInfo
var TxData = txd.TxData
var Permission = require('tradle-permission')
var pluck = require('./pluck')
var FILE_EVENTS = ['file:shared', 'file:public', 'file:permission']

module.exports = Loader
inherits(Loader, Transform)

/**
 * Load data from the chain (blockchain + keeper)
 * @param {Function} lookup (optional) - function to look up identities by fingerprints
 * @param {BitKeeper|BitKeeper client} keeper
 * @param {String} networkName
 * @param {String} prefix - prefix for OP_RETURN data
 * @param {Object} options
 */
function Loader (options) {
  var self = this

  typeforce({
    keeper: 'Object',
    networkName: 'String',
    prefix: 'String'
  }, options)

  typeforce({
    put: 'Function',
    getMany: 'Function'
  }, options.keeper)

  Transform.call(this, {
    objectMode: true,
    highWaterMark: 16
  })

  utils.bindPrototypeFunctions(this)

  extend(this, options)
  if (options.lookup) this.lookupWith(options.lookup)

  FILE_EVENTS.forEach(function (event) {
    self.on(event, function (data) {
      // self.saveIfNew(data)
      self.emit('file', data)
    })
  })
}

Loader.prototype._transform = function (tx, encoding, done) {
  var self = this
  this.load(tx)
    .catch(function (err) {
      self.emit('error', err)
      done()
    })
    .done(function (files) {
      if (files) {
        files.forEach(self.push, self)
      }

      done()
    })
}

/**
 *  Optimized data loading with minimum calls to keeper
 *  @return {Q.Promise} for files related to the passed in transactions/ids
 **/
Loader.prototype.load = function (txs) {
  var self = this
  txs = [].concat(txs)

  var results = []
  var shared = []
  var parsedTxs
  return this._parseTxs(txs)
    .then(function (_parsed) {
      parsedTxs = _parsed
      if (!parsedTxs.length) return

      parsedTxs.forEach(function (p, i) {
        p._pIdx = i // for sorting at the end
      })

      return self.fetchFiles(pluck(parsedTxs, 'key'))
    })
    .then(function (fetched) {
      if (!fetched || !fetched.length) return

      fetched.forEach(function (data, i) {
        if (!data) return

        var parsed = parsedTxs[i]
        if (parsed.txType === TxData.types.public) {
          parsed.data = data
          self.emit('file:public', parsed)
          return results.push(parsed)
        }

        if (!parsed.sharedKey) return

        parsed.encryptedPermission = data
        try {
          parsed.permission = Permission.recover(data, parsed.sharedKey)
          parsed.key = parsed.permission.fileKeyString()
          shared.push(parsed)
          self.emit('file:permission', parsed)
        } catch (err) {
          debug('Failed to recover permission file contents from raw data', err)
          return
        }
      })

      if (shared.length) {
        return self.fetchFiles(pluck(shared, 'key'))
      }
    })
    .then(function (sharedFiles) {
      if (sharedFiles && sharedFiles.length) {
        sharedFiles.forEach(function (file, idx) {
          if (!file) return

          var parsed = extend({}, shared[idx])
          parsed.key = parsed.permission.fileKeyString()
          parsed.encryptedData = file

          var decryptionKey = parsed.permission.decryptionKeyBuf()
          if (decryptionKey) {
            try {
              file = utils.decrypt(file, decryptionKey)
            } catch (err) {
              debug('Failed to decrypt ciphertext: ' + file)
              return
            }
          }

          parsed.data = file
          self.emit('file:shared', parsed)
          results.push(parsed)
        })
      }

      // sort to match order of originally passed in txs
      results.sort(function (a, b) {
        return a._pIdx - b._pIdx
      })

      results.forEach(function (p) {
        delete p._pIdx
      })

      return results
    })
}

/*
 * @param {Function} fn - function to look up identities by fingerprints (must return Promise)
 *   @example
 *     function lookup (cb) {
 *       cb(err, {
 *         key: key with pub/priv props or functions
 *       })
 *     }
 */
Loader.prototype.lookupWith = function (fn) {
  this.lookup = fn
  return this
}

// /**
//  * Attempt to deduce the permission key and ECDH shared key
//  *   from the parties involved in the bitcoin transaction
//  * @param  {Transaction} tx
//  * @param  {TransactionData} txData
//  * @return {Object}   permission file "key" and ECDH "sharedKey" to decrypt it
//  */
// Loader.prototype.deduceECDHKeys = function (tx, txData) {
//   if (!(this.wallet && txData)) return

//   var wallet = this.wallet
//   var myAddress
//   var myPrivKey
//   var theirPubKey
//   var toMe = this.getSentToMe(tx)
//   var fromMe = this.getSentFromMe(tx)
//   if (!toMe.length && !fromMe.length) {
//     debug("Cannot parse permission data from transaction as it's neither to me nor from me")
//     return
//   }

//   if (fromMe.length) {
//     tx.ins.some(function (input) {
//       var addr = utils.getAddressFromInput(input, this.networkName)
//       myPrivKey = wallet.addressString === addr && wallet.priv
//       return myPrivKey
//     }, this)

//     toMe.some(function (out) {
//       var addr = utils.getAddressFromOutput(out, this.networkName)
//       theirPubKey = addr === wallet.addressString && wallet.pub
//       return theirPubKey
//     }, this)
//   } else {
//     myAddress = utils.getAddressFromOutput(toMe[0], this.networkName)
//     myPrivKey = wallet.addressString === myAddress && wallet.priv
//     theirPubKey = bitcoin.ECPubKey.fromBuffer(tx.ins[0].script.chunks[1])
//   }

//   if (myPrivKey && theirPubKey) {
//     if (myPrivKey.pub.toHex() !== theirPubKey.toHex()) {
//       return {
//         priv: myPrivKey,
//         pub: theirPubKey
//       }
//     }
//   }

// }

/**
 *  @return {Array} outputs in tx that the underlying wallet can spend
 */
// Loader.prototype.getSentToMe = function (tx) {
//   if (!this.wallet) return []

//   return tx.outs.filter(function (out) {
//     var address = utils.getAddressFromOutput(out, this.networkName)
//     return this.wallet.addressString === address
//   }, this)
// }

/**
 *  @return {Array} inputs in tx that are signed by the underlying wallet
 */
// Loader.prototype.getSentFromMe = function (tx) {
//   if (!this.wallet) return []

//   return tx.ins.filter(function (input) {
//     var address = utils.getAddressFromInput(input, this.networkName)
//     return this.wallet.addressString === address
//   }, this)
// }

Loader.prototype.fetchFiles = function (keys) {
  return this.keeper.getMany(keys)
    .catch(function (err) {
      debug('Error fetching files', err)
      throw new Error(err.message || 'Failed to retrieve file from keeper')
    })
}

Loader.prototype._processTxInfo = function (parsed) {
  var self = this
  if (!TxInfo.validate(parsed)) {
    return Q.reject('invalid parsed tx')
  }

  return this._lookupParties(parsed.addressesFrom, parsed.addressesTo)
    .then(function (matches) {
      if (matches) {
        parsed.from = matches.from
        parsed.to = matches.to
      }

      if (parsed.txType === TxData.types.public) {
        parsed.key = parsed.txData.toString('hex')
      } else {
        if (!matches) return Q.reject('unknown tx participants')

        parsed.encryptedKey = parsed.txData
        parsed.sharedKey = self._getSharedKey(matches.from, matches.to)
        if (!parsed.sharedKey) return Q.reject('failed to get shared key')

        try {
          parsed.key = utils.decrypt(parsed.txData, parsed.sharedKey).toString('hex')
          parsed.permissionKey = parsed.key
        } catch (err) {
          var msg = 'Failed to decrypt permission key: ' + parsed.key
          debug(msg)
          return Q.reject(new Error(msg))
        }
      }

      return parsed
    })
}

Loader.prototype._getSharedKey = function (from, to) {
  if (!(from && to)) return

  var fromKey = from.key
  var toKey = to.key
  var priv = getResult(fromKey, 'priv')
  var pub = getResult(toKey, 'value')
  if (!priv) {
    priv = getResult(toKey, 'priv')
    pub = getResult(fromKey, 'value')
  }

  return priv && pub && utils.sharedEncryptionKey(priv, pub)
}

Loader.prototype._parseTxs = function (txs) {
  return getSuccessful(txs.map(this._parseTx, this))
}

Loader.prototype._parseTx = function (tx, cb) {
  // may already be parsed
  var parsed = TxInfo.validate(tx) ?
    tx :
    TxInfo.parse(tx, this.networkName, this.prefix)

  if (!parsed) return Q.reject()

  return this._processTxInfo(parsed)
}

/**
 * lookup parties in a tx
 * @param  {Array} from - bitcoin addresses
 * @param  {Array} to - bitcoin addresses
 * @return {Promise} uses this.lookup to lookup parties, resolves with:
 *  {
 *    from: result of this.lookup,
 *    to: result of this.lookup
 *  }
 */
Loader.prototype._lookupParties = function (from, to) {
  var self = this
  var matches = {}
  if (!this.lookup) return Q.resolve(matches)

  var allAddrs = from.concat(to)
  var lookups = allAddrs.map(function (f) {
    if (!f) return Q.reject()
    var promise = self.lookup(f, true) // private
    assert(Q.isPromiseAlike(promise), '"lookup" function should return a promise')
    return promise
  })

  return Q.allSettled(lookups)
    .then(function (results) {
      results = results.map(function (r) {
        return r.value
      })

      results.slice(0, from.length)
        .some(function (result) {
          if (result) {
            matches.from = result
            return true
          }
        })

      results.slice(from.length)
        .some(function (result) {
          if (result && matches.from && matches.from.key.value !== result.key.value) {
            matches.to = result
            return true
          }
        })

      return matches
    })

  // if (self.identity) {
  //   find(addrs.from, function (addr) {
  //     var key = self.identity.keys({ fingerprint: addr })[0]
  //     from = key && {
  //       key: key,
  //       identity: self.identity
  //     }

  //     return from
  //   })

  //   if (from.identity !== self.identity) {
  //     find(addrs.to, function (addr) {
  //       var key = self.identity.keys({ fingerprint: addr })[0]
  //       to = key && {
  //         key: key,
  //         identity: self.identity
  //       }

  //       return to
  //     })
  //   }
  // }

  // if (self.addressBook) {
  //   if (!from) {
  //     find(addrs.from, function (addr) {
  //       from = self.addressBook.byFingerprint(addr)
  //       return from
  //     })
  //   }

  //   if (!to) {
  //     find(addrs.to, function (addr) {
  //       to = self.addressBook.byFingerprint(addr)
  //       return to
  //     })
  //   }
  // }

  // parsed.from = from
  // parsed.to = to
}

function getResult (obj, p) {
  var val = obj[p]
  if (typeof val === 'function') return obj[p]()
  else return val
}

/**
 * gets results of fulfilled promises
 * @param  {Array} tasks that return promises
 * @return {Promise}
 */
function getSuccessful (tasks) {
  return Q.allSettled(tasks)
    .then(function (results) {
      return results.filter(function (p) {
          return p.state === 'fulfilled'
        })
        .map(function (result) {
          return result.value
        })
    })
}
