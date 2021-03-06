var crypto = require('crypto')
var protocolTester = require('external-protocol-tester')
var Vinyl = require('vinyl')
var path = require('path')
var fs = require('fs')
var util = require('util')
var through = require('through')

function toJSONBuffer(obj) {
    return new Buffer(JSON.stringify(obj, null, 1))
}

function ResourceFreezer(options) {
    this.config = Object.create(this.constructor.prototype.config)

    Object.assign(this.config, options)

    this.freezeMap = Object.create(null)

    this.freezeMapFile = new Vinyl({
        path: this.config.freezeMapFileName,
        base: '.',
        cwd: ''
    })

    this.freezeMapFile.freezerInstance = this
}

ResourceFreezer.prototype.config = {
    freezeNestingLevel: 1,
    freezeMapFileName: 'freeze-map.json',
    freezeMapBaseDir: null
}

ResourceFreezer.prototype.stream = function (pipeMainTransform) {
    var self = this

    var stream = this.createStream(pipeMainTransform, function endCallback() {
        this.queue(self.freezeMapFile)
        this.queue(null)
    })

    stream.pipe(this.createStream(this.pipeFrozenFilesCollectorTransform))

    stream.pipe(
        this.createStream(function endCallback(stream, sourceFile) {
            if (!sourceFile.freezerInstance) {
                return
            }

            var resolvedFreezeMap = self.resolveFreezeMap(self.freezeMap)

            self.freezeMapFile.contents = toJSONBuffer(resolvedFreezeMap)
        })
    )

    return stream
}

ResourceFreezer.prototype.createStream = function (transformCallback, endCallback) {
    var _this = this

    return through(function (sourceFile, enc, cb) {
        transformCallback.bind(_this, this).apply(_this, arguments)
    }, endCallback)
}

ResourceFreezer.prototype.freezeLinks = function freezeLinks(freezingFile, stream, _callback, _url) {
    var callback, url

    if (util.isString(_callback)) {
        url = _callback
        callback = undefined
    }
    else {
        url = _url
        callback = _callback
    }

    if (protocolTester.isExternalUrl(url)) {
        return url
    }

    var urlData = this.parsePath(url)

    var fileSourcePath = path.resolve(freezingFile.base, urlData.path)

    try {
        fs.statSync(fileSourcePath)
    }
    catch (e) {
        return url
    }
    
    var file = new Vinyl({
        base: '.',
        cwd: '',
        path: fileSourcePath,
        contents: fs.readFileSync(fileSourcePath)
    })

    var fileName = this.createFileName(file)
    var filePath = this.createFileSubDirPath(fileName)

    file.path = filePath
    file.sourcePath = fileSourcePath

    if (util.isFunction(callback)) {
        callback(freezingFile, stream, url, file)
    }

    stream.push(file)

    return filePath + urlData.query
}

ResourceFreezer.prototype.pipeFrozenFilesCollectorTransform = function pipeFrozenFilesCollectorTransform(stream, sourceFile) {
    if (sourceFile.sourcePath) {
        this.freezeMap[sourceFile.sourcePath] = sourceFile.path
    }
}

ResourceFreezer.prototype.resolveFreezeMap = function (freezeMap, destinationBaseDir, noResolveSourcePath) {
    if (!this.config.freezeMapBaseDir) {
        return freezeMap
    }

    var freezeMapBaseDir = this.config.freezeMapBaseDir,
        relativeFreezeMap = Object.create(null)

    var separatorRegexp = new RegExp(path.sep.replace(/\\/, '\\\\'), 'g')

    if (freezeMap) {
        Object.keys(freezeMap).forEach(function (sourcePath) {
            var frozenPath = freezeMap[sourcePath]

            if (util.isNullOrUndefined(noResolveSourcePath)) {
                sourcePath = path.relative(freezeMapBaseDir, sourcePath)
            }
            else {
                sourcePath = sourcePath.replace(separatorRegexp, '/')
            }

            if (!util.isNullOrUndefined(destinationBaseDir)) {
                frozenPath = path.relative(freezeMapBaseDir, path.join(destinationBaseDir, frozenPath))
            }

            // replace any OS path separator with slash(/)
            relativeFreezeMap[sourcePath] = frozenPath.replace(separatorRegexp, '/')
        }.bind(this))
    }

    return relativeFreezeMap
}

ResourceFreezer.prototype.resolveFrozenLinks = function resolveFrozenLinks(cssFilePath, url) {
    if (!this.config.freezeNestingLevel) {
        return url
    }

    var urlData = this.parsePath(url)

    var urlRelDir = path.relative(path.dirname(cssFilePath), path.dirname(urlData.path))

    return path.join(urlRelDir, path.basename(urlData.path) + urlData.query)
}

ResourceFreezer.prototype.parsePath = function parsePath(path) {
    var urlData = {
        path: '',
        query: ''
    }

    // Should keep ?query=attributes and other #hastags in url
    var urlUnparsed = path.replace(/([^#?]+)([#?]+.+)/i, function (match, path, query) {
        urlData.path = path
        urlData.query = query

        return ''
    })

    if (urlUnparsed) {
        urlData.path = path
    }

    return urlData
}

ResourceFreezer.prototype.createFileName = function createFileName(file) {
    var fileBaseName = crypto.createHash('sha1').update(file.contents).digest('hex')
    var fileExt = path.extname(file.path)

    return fileBaseName + fileExt
}

ResourceFreezer.prototype.createFileSubDirPath = function (filePath) {
    if (!this.config.freezeNestingLevel) {
        return filePath
    }

    var filename = path.basename(filePath, path.extname(filePath))

    var subDirs = []

    for (var level = 0, maxLevel = this.config.freezeNestingLevel, char; level < maxLevel; level++) {
        char = filename.substr(level, 1)

        if (char) {
            subDirs.push(char)
        }
        else {
            break
        }
    }

    return path.join(subDirs.join('/'), filePath)
}

ResourceFreezer.toJSONBuffer = toJSONBuffer

ResourceFreezer.freezeMapResolve = function freezeMapResolve() {
    var freezeMapFile,
        freezerInstance

    return through(
        function write(sourceFile) {
            if (!sourceFile.freezerInstance) {
                return
            }

            freezeMapFile = sourceFile
            freezerInstance = sourceFile.freezerInstance

            var freezeMap = sourceFile.contents ? JSON.parse(sourceFile.contents.toString('utf-8')) : null

            var destinationBaseDir = path.dirname(sourceFile.path)

            var resolvedFreezeMap = freezerInstance.resolveFreezeMap(freezeMap, destinationBaseDir, true)

            sourceFile.contents = toJSONBuffer(resolvedFreezeMap)

            this.emit('data', sourceFile)
        }
    )
}

module.exports = ResourceFreezer