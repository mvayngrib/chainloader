
var assert = require('assert')
var Transform = require('readable-stream').Transform
var Q = require('q')
var typeForce = require('typeforce')
var utils = require('tradle-utils')
var debug = require('debug')('chainloader')
var inherits = require('util').inherits
var extend = require('extend')
var getTxInfo = require('tradle-tx-data').getTxInfo
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

  typeForce({
    keeper: 'Object',
    networkName: 'String',
    prefix: 'String'
  }, options)

  typeForce({
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
    .catch(done)
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

  return this._parseTxs(txs)
    .then(onParsed)

  function onParsed (parsed) {
    if (!parsed.length) return Q.resolve()

    var pub = parsed.filter(function (p) { return p.type === 'public' })
    var enc = parsed.filter(function (p) { return p.type === 'permission' })
    var keys = pluck(pub, 'key').concat(pluck(enc, 'permissionKey'))
    var shared
    var files = []
    return self.fetchFiles(keys)
      .then(function (fetched) {
        if (!fetched.length) return

        pub.forEach(function (parsed, i) {
          if (fetched[i]) {
            parsed.data = fetched[i]
            self.emit('file:public', parsed)
            files.push(parsed)
          }
        })

        if (!enc.length) return

        shared = enc.filter(function (parsed, i) {
          var file = fetched[i + pub.length]
          if (!file) return

          try {
            parsed.permission = Permission.recover(file, parsed.sharedKey)
            parsed.key = parsed.permission.fileKeyString()
          } catch (err) {
            debug('Failed to recover permission file contents from raw data', err)
            return
          }

          self.emit('file:permission', parsed)
          return true
        })

        if (!shared.length) return

        return self.fetchFiles(pluck(shared, 'key'))
      })
      .then(function (sharedFiles) {
        if (sharedFiles) {
          sharedFiles.forEach(function (file, idx) {
            var parsed = extend({}, shared[idx])
            parsed.key = parsed.permission.fileKeyString()
            parsed.type = 'sharedfile'

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
            files.push(parsed)
          })
        }

        return files.sort(function (a, b) {
          return txs.indexOf(a.tx.body) - txs.indexOf(b.tx.body)
        })
      })
  }
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

// Loader.prototype.saveIfNew = function (data) {
//   var self = this

//   var wallet = this.wallet
//   if (!wallet) return

//   var tx = data.tx.body
//   var metadata = data.tx.metadata
//   if (!metadata || metadata.confirmations) return

//   var received = !wallet.isSentByMe(tx)
//   var type = received ? 'received' : 'sent'
//   return this.keeper.put(data.file)
//     .then(function () {
//       self.emit('file:' + type, data)
//     })
// }

Loader.prototype._getSharedKey = function (parsed) {
  if (!(parsed.from && parsed.to)) return

  var from = parsed.from.key
  var to = parsed.to.key
  var priv = getResult(from, 'priv')
  var pub = getResult(to, 'pub')
  if (!priv) {
    priv = getResult(to, 'priv')
    pub = getResult(from, 'pub')
  }

  return priv && pub && utils.sharedEncryptionKey(priv, pub)
}

Loader.prototype._parseTxs = function (txs) {
  return Q.all(txs.map(this._parseTx, this))
    .then(function (parsed) {
      return parsed.filter(function (p) {
        return !!p
      })
    })
}

Loader.prototype._parseTx = function (tx, cb) {
  var self = this
  var parsed = getTxInfo(tx, self.networkName, self.prefix)
  if (!parsed) return Q.resolve()

  var addrs = parsed.tx.addresses
  if (!this.lookup) return onlookedup()

  var allAddrs = addrs.from.concat(addrs.to)
  var lookups = allAddrs.map(function (f) {
    var promise = self.lookup(f, true) // private
    assert(Q.isPromiseAlike(promise), '"lookup" function should return a promise')
    return promise
  })

  return Q.allSettled(lookups)
    .then(function (results) {
      results = results.map(function (r) {
        return r.value
      })

      results.slice(0, addrs.from.length)
        .some(function (result) {
          if (result) {
            parsed.from = result
            return true
          }
        })

      results.slice(addrs.from.length)
        .some(function (result) {
          if (result && parsed.from && !parsed.from.key.equals(result.key)) {
            parsed.to = result
            return true
          }
        })

      return onlookedup()
    })

  function onlookedup () {
    if (parsed.type !== 'public') {
      parsed.sharedKey = self._getSharedKey(parsed)
      if (parsed.sharedKey) {
        try {
          parsed.key = utils.decrypt(parsed.key, parsed.sharedKey)
          parsed.permissionKey = parsed.key
        } catch (err) {
          debug('Failed to decrypt permission key: ' + parsed.key)
          return
        }
      }
    }

    parsed.key = parsed.key.toString('hex')
    if (parsed.permissionKey) {
      parsed.permissionKey = parsed.permissionKey.toString('hex')
    }

    return parsed
  }

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
