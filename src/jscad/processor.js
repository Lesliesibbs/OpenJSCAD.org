import log from './log' // logging helper
import getParamDefinitions from './getParamDefinitions'
import createJscadFunction from './jscad-function'
import convertToSolid from './convertToSolid'
// import createJscadWorker from ''

import { revokeBlobUrl } from '../utils/Blob'
import { version } from '../jscad/version'

import { isSafari } from '../ui/detectBrowser'
import { getWindowURL } from '../ui/urlHelpers'
import FileSystemApiErrorHandler from '../ui/fileSystemApiErrorHandler'
import Viewer from '../ui/viewer/jscad-viewer'

// FIXME: hack for now
import * as primitives3d from '../modeling/primitives3d'
import * as primitives2d from '../modeling/primitives2d'
import * as booleanOps from '../modeling/ops-booleans'
import * as csg from '../csg'
/*window.cube = cube
window.sphere = sphere
window.union = union
window.intersection = intersection
window.difference = difference
window.CSG = CSG
window.CAG = CAG*/

/*
 * exposes the properties of an object to the given scope object (for example WINDOW etc)
 * this is the same as {foo, bar} = baz
 * window.bar = bar
 * window.foo = foo
*/
function exposeAPI (object, scope = window) {
  Object.keys(object).forEach(function (key) {
    scope[key] = object[key]
  })
}

exposeAPI(primitives2d)
exposeAPI(primitives3d)
exposeAPI(booleanOps)
exposeAPI(csg)

export default function Processor (containerdiv, options) {
  if (options === undefined) options = {}
  // the default options
  this.opts = {
    debug: false,
    libraries: ['js/lib/csg.js', 'js/formats.js', 'js/js', 'js/openscad.js'],
    openJsCadPath: '',
    useAsync: true,
    useSync: true,
    viewer: {}
  }
  // apply all options found
  for (var x in this.opts) {
    if (x in options) this.opts[x] = options[x]
  }

  this.containerdiv = containerdiv

  this.viewer = null
  this.worker = null
  this.zoomControl = null

  // callbacks
  this.onchange = null // function(Processor) for callback
  this.ondownload = null // function(Processor) for callback

  this.currentObjects = [] // list of objects returned from rebuildObject*
  this.viewedObject = null // the object being rendered

  this.selectStartPoint = 0
  this.selectEndPoint = 0

  this.hasOutputFile = false
  this.hasError = false
  this.paramDefinitions = []
  this.paramControls = []
  this.script = null
  this.formats = null

  this.baseurl = document.location.href
  this.baseurl = this.baseurl.replace(/#.*$/, '') // remove remote URL
  this.baseurl = this.baseurl.replace(/\?.*$/, '') // remove parameters
  if (this.baseurl.lastIndexOf('/') !== (this.baseurl.length - 1)) {
    this.baseurl = this.baseurl.substring(0, this.baseurl.lastIndexOf('/') + 1)
  }

  // state of the processor
  // 0 - initialized - no viewer, no parameters, etc
  // 1 - processing  - processing JSCAD script
  // 2 - complete    - completed processing
  // 3 - incomplete  - incompleted due to errors in processing
  this.state = 0 // initialized

  // FIXME: UI only, seperate
  this.createElements()
}

Processor.convertToSolid = convertToSolid

Processor.prototype = {
  createElements: function () {
    console.log('createElements')
    var that = this // for event handlers

    while(this.containerdiv.children.length > 0){
      this.containerdiv.removeChild(0)
    }

    var viewerdiv = document.createElement('div')
    viewerdiv.className = 'viewer'
    viewerdiv.style.width = '100%'
    viewerdiv.style.height = '100%'
    this.containerdiv.appendChild(viewerdiv)
    try {
      this.viewer = new Viewer(viewerdiv, this.opts.viewer)
    } catch(e) {
      viewerdiv.innerHTML = '<b><br><br>Error: ' + e.toString() + '</b><br><br>A browser with support for WebGL is required'
    }
    // Zoom control
    if (0) { // FIXME: what the heck ?
      var div = document.createElement('div')
      this.zoomControl = div.cloneNode(false)
      this.zoomControl.style.width = this.viewerwidth + 'px'
      this.zoomControl.style.height = '20px'
      this.zoomControl.style.backgroundColor = 'transparent'
      this.zoomControl.style.overflowX = 'scroll'
      div.style.width = this.viewerwidth * 11 + 'px'
      div.style.height = '1px'
      this.zoomControl.appendChild(div)
      this.zoomChangedBySlider = false
      this.zoomControl.onscroll = function (event) {
        var zoom = that.zoomControl
        var newzoom = zoom.scrollLeft / (10 * zoom.offsetWidth)
        that.zoomChangedBySlider = true // prevent recursion via onZoomChanged
        that.viewer.setZoom(newzoom)
        that.zoomChangedBySlider = false
      }
      this.viewer.onZoomChanged = function () {
        if (!that.zoomChangedBySlider) {
          var newzoom = that.viewer.getZoom()
          that.zoomControl.scrollLeft = newzoom * (10 * that.zoomControl.offsetWidth)
        }
      }

      this.containerdiv.appendChild(this.zoomControl)
      this.zoomControl.scrollLeft = this.viewer.viewpointZ / this.viewer.camera.clip.max *
        (this.zoomControl.scrollWidth - this.zoomControl.offsetWidth)

    // end of zoom control
    }

    this.selectdiv = this.containerdiv.parentElement.querySelector('div#selectdiv')
    if (!this.selectdiv) {
      this.selectdiv = document.createElement('div')
      this.selectdiv.id = 'selectdiv'
      this.containerdiv.parentElement.appendChild(this.selectdiv)
    }
    var element = document.createElement('input')
    element.setAttribute('type', 'range')
    element.id = 'startRange'
    element.min = 0
    element.max = 100
    element.step = 1
    element.oninput = function (e) {
      if (that.state === 2) {
        that.updateView()
        that.updateFormats()
        that.updateDownloadLink()
      }
    }
    this.selectdiv.appendChild(element)
    element = document.createElement('input')
    element.setAttribute('type', 'range')
    element.id = 'endRange'
    element.min = 0
    element.max = 100
    element.step = 1
    element.oninput = function (e) {
      if (that.state === 2) {
        that.updateView()
        that.updateFormats()
        that.updateDownloadLink()
      }
    }
    this.selectdiv.appendChild(element)

    this.errordiv = this.containerdiv.parentElement.querySelector('div#errordiv')
    if (!this.errordiv) {
      this.errordiv = document.createElement('div')
      this.errordiv.id = 'errordiv'
      this.containerdiv.parentElement.appendChild(this.errordiv)
    }
    this.errorpre = document.createElement('pre')
    this.errordiv.appendChild(this.errorpre)

    this.statusdiv = this.containerdiv.parentElement.querySelector('div#statusdiv')
    if (!this.statusdiv) {
      this.statusdiv = document.createElement('div')
      this.statusdiv.id = 'statusdiv'
      this.containerdiv.parentElement.appendChild(this.statusdiv)
    }
    this.statusspan = document.createElement('span')
    this.statusspan.id = 'statusspan'
    this.statusbuttons = document.createElement('span')
    this.statusbuttons.id = 'statusbuttons'
    this.statusdiv.appendChild(this.statusspan)
    this.statusdiv.appendChild(this.statusbuttons)
    this.abortbutton = document.createElement('button')
    this.abortbutton.innerHTML = 'Abort'
    this.abortbutton.onclick = function (e) {
      that.abort()
    }
    this.statusbuttons.appendChild(this.abortbutton)
    this.formatDropdown = document.createElement('select')
    this.formatDropdown.onchange = function (e) {
      that.currentFormat = that.formatDropdown.options[that.formatDropdown.selectedIndex].value
      that.updateDownloadLink()
    }
    this.statusbuttons.appendChild(this.formatDropdown)
    this.generateOutputFileButton = document.createElement('button')
    this.generateOutputFileButton.onclick = function (e) {
      that.generateOutputFile()
    }
    this.statusbuttons.appendChild(this.generateOutputFileButton)
    this.downloadOutputFileLink = document.createElement('a')
    this.downloadOutputFileLink.className = 'downloadOutputFileLink' // so we can css it
    this.statusbuttons.appendChild(this.downloadOutputFileLink)

    this.parametersdiv = this.containerdiv.parentElement.querySelector('div#parametersdiv')
    if (!this.parametersdiv) {
      this.parametersdiv = document.createElement('div')
      this.parametersdiv.id = 'parametersdiv'
      this.containerdiv.parentElement.appendChild(this.parametersdiv)
    }
    this.parameterstable = document.createElement('table')
    this.parameterstable.className = 'parameterstable'
    this.parametersdiv.appendChild(this.parameterstable)

    element = this.parametersdiv.querySelector('button#updateButton')
    if (element === null) {
      element = document.createElement('button')
      element.innerHTML = 'Update'
      element.id = 'updateButton'
    }
    element.onclick = function (e) {
      that.rebuildSolid()
    }
    this.parametersdiv.appendChild(element)

    // implementing instantUpdate
    var instantUpdateCheckbox = document.createElement('input')
    instantUpdateCheckbox.type = 'checkbox'
    instantUpdateCheckbox.id = 'instantUpdate'
    this.parametersdiv.appendChild(instantUpdateCheckbox)

    element = document.getElementById('instantUpdateLabel')
    if (element === null) {
      element = document.createElement('label')
      element.innerHTML = 'Instant Update'
      element.id = 'instantUpdateLabel'
    }
    element.setAttribute('for', instantUpdateCheckbox.id)
    this.parametersdiv.appendChild(element)

    this.enableItems()
    this.clearViewer()
  },

  setCurrentObjects: function (objs) {
    if (!(length in objs)) {
      objs = [objs] // create a list
    }
    this.currentObjects = objs // list of CAG or CSG objects

    this.updateSelection()
    this.selectStartPoint = -1 // force view update
    this.updateView()
    this.updateFormats()
    this.updateDownloadLink()

    if (this.onchange) this.onchange(this)
  },

  selectedFormat: function () {
    return this.formatDropdown.options[this.formatDropdown.selectedIndex].value
  },

  selectedFormatInfo: function () {
    return this.formatInfo(this.selectedFormat())
  },

  updateDownloadLink: function () {
    var info = this.selectedFormatInfo()
    var ext = info.extension
    this.generateOutputFileButton.innerHTML = 'Generate ' + ext.toUpperCase()
  },

  updateSelection: function () {
    var range = document.getElementById('startRange')
    range.min = 0
    range.max = this.currentObjects.length - 1
    range.value = 0
    range = document.getElementById('endRange')
    range.min = 0
    range.max = this.currentObjects.length - 1
    range.value = this.currentObjects.length - 1
  },

  updateView: function () {
    var startpoint = parseInt(document.getElementById('startRange').value, 10)
    var endpoint = parseInt(document.getElementById('endRange').value, 10)
    if (startpoint === this.selectStartPoint && endpoint === this.selectEndPoint) { return }

    // build a list of objects to view
    this.selectStartPoint = startpoint
    this.selectEndPoint = endpoint
    if (startpoint > endpoint) { startpoint = this.selectEndPoint; endpoint = this.selectStartPoint; }

    var objs = this.currentObjects.slice(startpoint, endpoint + 1)
    this.viewedObject = convertToSolid(objs) // enforce CSG to display

    if (this.viewer) {
      this.viewer.setCsg(this.viewedObject)
    }
  },

  updateFormats: function () {
    while(this.formatDropdown.options.length > 0) {
      this.formatDropdown.options.remove(0)
    }

    var that = this
    var formats = this.supportedFormatsForCurrentObjects()
    formats.forEach(function (format) {
      var option = document.createElement('option')
      var info = that.formatInfo(format)
      option.setAttribute('value', format)
      option.appendChild(document.createTextNode(info.displayName))
      that.formatDropdown.options.add(option)
    })
  },

  clearViewer: function () {
    this.clearOutputFile()
    if (this.viewedObject) {
      this.viewer.clear()
      this.viewedObject = null
      if (this.onchange) this.onchange(this)
    }
    this.enableItems()
  },

  abort: function () {
    // abort if state is processing
    if (this.state === 1) {
      // todo: abort
      this.setStatus('Aborted.')
      this.worker.terminate()
      this.state = 3 // incomplete
      this.enableItems()
      if (this.onchange) this.onchange(this)
    }
  },

  enableItems: function () {
    this.abortbutton.style.display = (this.state === 1) ? 'inline' : 'none'
    this.formatDropdown.style.display = ((!this.hasOutputFile) && (this.viewedObject)) ? 'inline' : 'none'
    this.generateOutputFileButton.style.display = ((!this.hasOutputFile) && (this.viewedObject)) ? 'inline' : 'none'
    this.downloadOutputFileLink.style.display = this.hasOutputFile ? 'inline' : 'none'
    this.parametersdiv.style.display = (this.paramControls.length > 0) ? 'inline-block' : 'none'; // was 'block'
    this.errordiv.style.display = this.hasError ? 'block' : 'none'
    this.statusdiv.style.display = this.hasError ? 'none' : 'block'
    this.selectdiv.style.display = (this.currentObjects.length > 1) ? 'none' : 'none'; // FIXME once there's a data model
  },

  setDebugging: function (debugging) {
    this.opts.debug = debugging
  },

  addLibrary: function (lib) {
    this.opts['libraries'].push(lib)
  },

  setOpenJsCadPath: function (path) {
    this.opts['openJsCadPath'] = path
  },

  setError: function (txt) {
    this.hasError = (txt != '')
    this.errorpre.textContent = txt
    this.enableItems()
  },

  setStatus: function (txt) {
    if (typeof document !== 'undefined') {
      this.statusspan.innerHTML = txt
    } else {
      log(txt)
    }
  },

  // script: javascript code
  // filename: optional, the name of the .jscad file
  setJsCad: function (script, filename) {
    console.log('setJsCad', script, filename)
    if (!filename) filename = 'openjscad.jscad'

    this.abort()
    this.paramDefinitions = []
    this.paramControls = []
    this.script = null
    this.setError('')

    var scripthaserrors = false
    try {
      this.paramDefinitions = getParamDefinitions(script)
      this.createParamControls()
    } catch(e) {
      this.setError(e.toString())
      this.setStatus('Error.')
      scripthaserrors = true
    }
    if (!scripthaserrors) {
      this.script = script
      this.filename = filename
      this.rebuildSolid()
    } else {
      this.enableItems()
    }
  },

  getParamValues: function () {
    var paramValues = {}
    for (var i = 0; i < this.paramControls.length; i++) {
      var control = this.paramControls[i]
      switch (control.paramType) {
        case 'choice':
          paramValues[control.paramName] = control.options[control.selectedIndex].value
          break
        case 'float':
        case 'number':
          var value = control.value
          if (!isNaN(parseFloat(value)) && isFinite(value)) {
            paramValues[control.paramName] = parseFloat(value)
          } else {
            throw new Error('Parameter (' + control.paramName + ') is not a valid number (' + value + ')')
          }
          break
        case 'int':
          var value = control.value
          if (!isNaN(parseFloat(value)) && isFinite(value)) {
            paramValues[control.paramName] = parseInt(value)
          } else {
            throw new Error('Parameter (' + control.paramName + ') is not a valid number (' + value + ')')
          }
          break
        case 'checkbox':
        case 'radio':
          if (control.checked === true && control.value.length > 0) {
            paramValues[control.paramName] = control.value
          } else {
            paramValues[control.paramName] = control.checked
          }
          break
        default:
          paramValues[control.paramName] = control.value
          break
      }
    // console.log(control.paramName+":"+paramValues[control.paramName])
    }
    return paramValues
  },

  getFullScript: function () {
    var script = ''
    // add the file cache
    script += 'var gMemFs = ['
    if (typeof (gMemFs) === 'object') {
      var comma = ''
      for (var fn in gMemFs) {
        script += comma
        script += JSON.stringify(gMemFs[fn])
        comma = ','
      }
    }
    script += '];\n'
    script += '\n'
    // add the main script
    script += this.script
    return script
  },

  rebuildSolidAsync: function () {
    var parameters = this.getParamValues()
    var script = this.getFullScript()

    if (!window.Worker) throw new Error('Worker threads are unsupported.')

    // create the worker
    var that = this
    that.state = 1 // processing
    that.worker = createJscadWorker(this.baseurl + this.filename, script,
      // handle the results
      function (err, objs) {
        that.worker = null
        if (err) {
          that.setError(err)
          that.setStatus('Error.')
          that.state = 3 // incomplete
        } else {
          that.setCurrentObjects(objs)
          that.setStatus('Ready.')
          that.state = 2 // complete
        }
        that.enableItems()
      }
    )
    // pass the libraries to the worker for import
    var libraries = this.opts.libraries.map(function (l) {
      return this.baseurl + this.opts.openJsCadPath + l
    }, this)
    // start the worker
    that.worker.postMessage({cmd: 'render', parameters, libraries})
  },

  rebuildSolidSync: function () {
    var parameters = this.getParamValues()
    try {
      this.state = 1 // processing
      var func = createJscadFunction(this.baseurl + this.filename, this.script)
      var objs = func(parameters)
      this.setCurrentObjects(objs)
      this.setStatus('Ready.')
      this.state = 2 // complete
    } catch(err) {
      var errtxt = err.toString()
      if (err.stack) {
        errtxt += '\nStack trace:\n' + err.stack
      }
      this.setError(errtxt)
      this.setStatus('Error.')
      this.state = 3 // incomplete
    }
    this.enableItems()
  },

  rebuildSolid: function () {
    // clear previous solid and settings
    this.abort()
    this.setError('')
    this.clearViewer()
    this.enableItems()
    this.setStatus("Rendering. Please wait <img id=busy src='imgs/busy.gif'>")
    // rebuild the solid
    if (this.opts.useAsync) {
      try {
        this.rebuildSolidAsync()
        return
      } catch(err) {
        if (! this.opts.useSync) {
          var errtxt = err.toString()
          if (err.stack) {
            errtxt += '\nStack trace:\n' + err.stack
          }
          this.setError(errtxt)
          this.setStatus('Error.')
          this.state = 3 // incomplete
          this.enableItems()
        }
      }
    }
    if (this.opts.useSync) {
      this.rebuildSolidSync()
    }
  },

  getState: function () {
    return this.state
  },

  clearOutputFile: function () {
    if (this.hasOutputFile) {
      this.hasOutputFile = false
      if (this.outputFileDirEntry) {
        this.outputFileDirEntry.removeRecursively(function () {})
        this.outputFileDirEntry = null
      }
      if (this.outputFileBlobUrl) {
        revokeBlobUrl(this.outputFileBlobUrl)
        this.outputFileBlobUrl = null
      }
      this.enableItems()
    }
  },

  generateOutputFile: function () {
    this.clearOutputFile()
    if (this.viewedObject) {
      try {
        this.generateOutputFileFileSystem()
      } catch(e) {
        this.generateOutputFileBlobUrl()
      }
      if (this.ondownload) this.ondownload(this)
    }
  },

  currentObjectsToBlob: function () {
    var startpoint = this.selectStartPoint
    var endpoint = this.selectEndPoint
    if (startpoint > endpoint) { startpoint = this.selectEndPoint; endpoint = this.selectStartPoint; }

    var objs = this.currentObjects.slice(startpoint, endpoint + 1)

    return this.convertToBlob(objs, this.selectedFormat())
  },

  convertToBlob: function (objs, format) {
    var formatInfo = this.formatInfo(format)
    // review the given objects
    var i
    var foundCSG = false
    var foundCAG = false
    for (i = 0; i < objs.length; i++) {
      if (objs[i] instanceof CSG) { foundCSG = true; }
      if (objs[i] instanceof CAG) { foundCAG = true; }
    }
    // convert based on the given format
    foundCSG = foundCSG && formatInfo.convertCSG
    foundCAG = foundCAG && formatInfo.convertCAG
    if (foundCSG && foundCAG) { foundCAG = false; } // use 3D conversion

    var object = new CSG()
    if (foundCSG === false) { object = new CAG(); }
    for (i = 0; i < objs.length; i++) {
      if (foundCSG === true && objs[i] instanceof CAG) {
        object = object.union(objs[i].extrude({offset: [0, 0, 0.1]})) // convert CAG to a thin solid CSG
        continue
      }
      if (foundCAG === true && objs[i] instanceof CSG) {
        continue
      }
      object = object.union(objs[i])
    }

    var blob = null
    switch (format) {
      case 'stla':
        blob = object.toStlString()
        // blob = object.fixTJunctions().toStlString()
        break
      case 'stlb':
        // blob = this.viewedObject.fixTJunctions().toStlBinary();   // gives normal errors, but we keep it for now (fixTJunctions() needs debugging)
        blob = object.toStlBinary({webBlob: true})
        break
      case 'amf':
        blob = object.toAMFString({
          producer: 'OpenJSCAD.org ' + version,
          date: new Date()
        })
        blob = new Blob([blob], { type: formatInfo.mimetype })
        break
      case 'x3d':
        blob = object.fixTJunctions().toX3D()
        break
      case 'dxf':
        blob = object.toDxf()
        break
      case 'svg':
        blob = object.toSvg()
        break
      case 'jscad':
        blob = new Blob([this.script], {type: formatInfo.mimetype })
        break
      case 'json':
        blob = object.toJSON()
        break
      default:
        throw new Error('Not supported')
    }
    return blob
  },

  supportedFormatsForCurrentObjects: function () {
    var startpoint = this.selectStartPoint
    var endpoint = this.selectEndPoint
    if (startpoint > endpoint) { startpoint = this.selectEndPoint; endpoint = this.selectStartPoint; }

    var objs = this.currentObjects.slice(startpoint, endpoint + 1)

    this.formatInfo('stla') // make sure the formats are initialized

    var objectFormats = []
    var i
    var format
    var foundCSG = false
    var foundCAG = false
    for (i = 0; i < objs.length; i++) {
      if (objs[i] instanceof CSG) { foundCSG = true; }
      if (objs[i] instanceof CAG) { foundCAG = true; }
    }
    for (format in this.formats) {
      if (foundCSG && this.formats[format].convertCSG === true) {
        objectFormats[objectFormats.length] = format
        continue // only add once
      }
      if (foundCAG && this.formats[format].convertCAG === true) {
        objectFormats[objectFormats.length] = format
      }
    }
    return objectFormats
  },

  formatInfo: function (format) {
    if (this.formats === null) {
      this.formats = {
        stla: { displayName: 'STL (ASCII)', extension: 'stl', mimetype: 'application/sla', convertCSG: true, convertCAG: false },
        stlb: { displayName: 'STL (Binary)', extension: 'stl', mimetype: 'application/sla', convertCSG: true, convertCAG: false },
        amf: { displayName: 'AMF (experimental)', extension: 'amf', mimetype: 'application/amf+xml', convertCSG: true, convertCAG: false },
        x3d: { displayName: 'X3D', extension: 'x3d', mimetype: 'model/x3d+xml', convertCSG: true, convertCAG: false },
        dxf: { displayName: 'DXF', extension: 'dxf', mimetype: 'application/dxf', convertCSG: false, convertCAG: true },
        jscad: { displayName: 'JSCAD', extension: 'jscad', mimetype: 'application/javascript', convertCSG: true, convertCAG: true },
        svg: { displayName: 'SVG', extension: 'svg', mimetype: 'image/svg+xml', convertCSG: false, convertCAG: true },
      }
    }
    return this.formats[format]
  },

  downloadLinkTextForCurrentObject: function () {
    var ext = this.selectedFormatInfo().extension
    return 'Download ' + ext.toUpperCase()
  },

  generateOutputFileBlobUrl: function () {
    if (isSafari()) {
      // console.log("Trying download via DATA URI")
      // convert BLOB to DATA URI
      var blob = this.currentObjectsToBlob()
      var that = this
      var reader = new FileReader()
      reader.onloadend = function () {
        if (reader.result) {
          that.hasOutputFile = true
          that.downloadOutputFileLink.href = reader.result
          that.downloadOutputFileLink.innerHTML = that.downloadLinkTextForCurrentObject()
          var ext = that.selectedFormatInfo().extension
          that.downloadOutputFileLink.setAttribute('download', 'openjscad.' + ext)
          that.downloadOutputFileLink.setAttribute('target', '_blank')
          that.enableItems()
        }
      }
      reader.readAsDataURL(blob)
    } else {
      // console.log("Trying download via BLOB URL")
      // convert BLOB to BLOB URL (HTML5 Standard)
      var blob = this.currentObjectsToBlob()
      var windowURL = getWindowURL()
      this.outputFileBlobUrl = windowURL.createObjectURL(blob)
      if (!this.outputFileBlobUrl) throw new Error('createObjectURL() failed')
      this.hasOutputFile = true
      this.downloadOutputFileLink.href = this.outputFileBlobUrl
      this.downloadOutputFileLink.innerHTML = this.downloadLinkTextForCurrentObject()
      var ext = this.selectedFormatInfo().extension
      this.downloadOutputFileLink.setAttribute('download', 'openjscad.' + ext)
      this.enableItems()
    }
  },

  generateOutputFileFileSystem: function () {
    var request = window.requestFileSystem || window.webkitRequestFileSystem
    if (!request) {
      throw new Error('Your browser does not support the HTML5 FileSystem API. Please try the Chrome browser instead.')
    }
    // console.log("Trying download via FileSystem API")
    // create a random directory name:
    var extension = this.selectedFormatInfo().extension
    var dirname = 'OpenJsCadOutput1_' + parseInt(Math.random() * 1000000000, 10) + '_' + extension
    var filename = 'output.' + extension; // FIXME this should come from this.filename
    var that = this
    request(TEMPORARY, 20 * 1024 * 1024, function (fs) {
      fs.root.getDirectory(dirname, {create: true, exclusive: true}, function (dirEntry) {
        that.outputFileDirEntry = dirEntry // save for later removal
        dirEntry.getFile(filename, {create: true, exclusive: true}, function (fileEntry) {
          fileEntry.createWriter(function (fileWriter) {
            fileWriter.onwriteend = function (e) {
              that.hasOutputFile = true
              that.downloadOutputFileLink.href = fileEntry.toURL()
              that.downloadOutputFileLink.type = that.selectedFormatInfo().mimetype
              that.downloadOutputFileLink.innerHTML = that.downloadLinkTextForCurrentObject()
              that.downloadOutputFileLink.setAttribute('download', fileEntry.name)
              that.enableItems()
            }
            fileWriter.onerror = function (e) {
              throw new Error('Write failed: ' + e.toString())
            }
            var blob = that.currentObjectsToBlob()
            fileWriter.write(blob)
          },
            function (fileerror) {FileSystemApiErrorHandler(fileerror, 'createWriter');}
          )
        },
          function (fileerror) {FileSystemApiErrorHandler(fileerror, "getFile('" + filename + "')");}
        )
      },
        function (fileerror) {FileSystemApiErrorHandler(fileerror, "getDirectory('" + dirname + "')");}
      )
    },
      function (fileerror) {FileSystemApiErrorHandler(fileerror, 'requestFileSystem');}
    )
  },

  createGroupControl: function (definition) {
    var control = document.createElement('title')
    control.paramName = definition.name
    control.paramType = definition.type
    if ('caption' in definition) {
      control.text = definition.caption
      control.className = 'caption'
    } else {
      control.text = definition.name
    }
    return control
  },

  createChoiceControl: function (definition) {
    if (!('values' in definition)) {
      throw new Error('Definition of choice parameter (' + definition.name + ") should include a 'values' parameter")
    }
    var control = document.createElement('select')
    control.paramName = definition.name
    control.paramType = definition.type
    var values = definition.values
    var captions
    if ('captions' in definition) {
      captions = definition.captions
      if (captions.length != values.length) {
        throw new Error('Definition of choice parameter (' + definition.name + ") should have the same number of items for 'captions' and 'values'")
      }
    } else {
      captions = values
    }
    var selectedindex = 0
    for (var valueindex = 0; valueindex < values.length; valueindex++) {
      var option = document.createElement('option')
      option.value = values[valueindex]
      option.text = captions[valueindex]
      control.add(option)
      if ('default' in definition) {
        if (definition['default'] === values[valueindex]) {
          selectedindex = valueindex
        }
      }
      else if ('initial' in definition) {
        if (definition.initial === values[valueindex]) {
          selectedindex = valueindex
        }
      }
    }
    if (values.length > 0) {
      control.selectedIndex = selectedindex
    }
    return control
  },

  createControl: function (definition) {
    var control_list = [
      {type: 'text',     control: 'text',     required: ['index', 'type', 'name'], initial: ''},
      {type: 'int',      control: 'number',   required: ['index', 'type', 'name'], initial: 0},
      {type: 'float',    control: 'number',   required: ['index', 'type', 'name'], initial: 0.0},
      {type: 'number',   control: 'number',   required: ['index', 'type', 'name'], initial: 0.0},
      {type: 'checkbox', control: 'checkbox', required: ['index', 'type', 'name', 'checked'], initial: ''},
      {type: 'radio',    control: 'radio',    required: ['index', 'type', 'name', 'checked'], initial: ''},
      {type: 'color',    control: 'color',    required: ['index', 'type', 'name'], initial: '#000000'},
      {type: 'date',     control: 'date',     required: ['index', 'type', 'name'], initial: ''},
      {type: 'email',    control: 'email',    required: ['index', 'type', 'name'], initial: ''},
      {type: 'password', control: 'password', required: ['index', 'type', 'name'], initial: ''},
      {type: 'url',      control: 'url',      required: ['index', 'type', 'name'], initial: ''},
      {type: 'slider',   control: 'range',    required: ['index', 'type', 'name', 'min', 'max'], initial: 0, label: true},
    ]
    // check for required parameters
    if (!('type' in definition)) {
      throw new Error('Parameter definition (' + definition.index + ") must include a 'type' parameter")
    }
    var control = document.createElement('input')
    var i,j,c_type,p_name
    for (i = 0; i < control_list.length; i++) {
      c_type = control_list[i]
      if (c_type.type === definition.type) {
        for (j = 0; j < c_type.required.length; j++) {
          p_name = c_type.required[j]
          if (p_name in definition) {
            if (p_name === 'index') continue
            if (p_name === 'type') continue
            if (p_name === 'checked') { // setAttribute() only accepts strings
              control.checked = definition.checked
            } else {
              control.setAttribute(p_name, definition[p_name])
            }
          } else {
            throw new Error('Parameter definition (' + definition.index + ") must include a '" + p_name + "' parameter")
          }
        }
        break
      }
    }
    if (i === control_list.length) {
      throw new Error('Parameter definition (' + definition.index + ") is not a valid 'type'")
    }
    // set the control type
    control.setAttribute('type', c_type.control)
    // set name and type for obtaining values
    control.paramName = definition.name
    control.paramType = definition.type
    // determine initial value of control
    if ('initial' in definition) {
      control.value = definition.initial
    } else if ('default' in definition) {
      control.value = definition.default
    } else {
      control.value = c_type.initial
    }
    // set generic HTML attributes
    for (var property in definition) {
      if (definition.hasOwnProperty(property)) {
        if (c_type.required.indexOf(property) < 0) {
          control.setAttribute(property, definition[property])
        }
      }
    }
    // add a label if necessary
    if ('label' in c_type) {
      control.label = document.createElement('label')
      control.label.innerHTML = control.value
    }
    return control
  },

  createParamControls: function () {
    this.parameterstable.innerHTML = ''
    this.paramControls = []

    for (var i = 0; i < this.paramDefinitions.length; i++) {
      var paramdef = this.paramDefinitions[i]
      paramdef.index = i + 1

      var control = null
      var type = paramdef.type.toLowerCase()
      switch (type) {
        case 'choice':
          control = this.createChoiceControl(paramdef)
          break
        case 'group':
          control = this.createGroupControl(paramdef)
          break
        default:
          control = this.createControl(paramdef)
          break
      }
      // add the appropriate element to the table
      var tr = document.createElement('tr')
      if (type === 'group') {
        var th = document.createElement('th')
        if ('className' in control) {
          th.className = control.className
        }
        th.innerHTML = control.text
        tr.appendChild(th)
      } else {
        // implementing instantUpdate
        var that = this
        control.onchange = function (e) {
          var l = e.currentTarget.nextElementSibling
          if (l !== null && l.nodeName === 'LABEL') {
            l.innerHTML = e.currentTarget.value
          }
          if (document.getElementById('instantUpdate').checked === true) {
            that.rebuildSolid()
          }
        }
        this.paramControls.push(control)

        var td = document.createElement('td')
        var label = paramdef.name + ':'
        if ('caption' in paramdef) {
          label = paramdef.caption
          td.className = 'caption'
        }
        td.innerHTML = label
        tr.appendChild(td)
        td = document.createElement('td')
        td.appendChild(control)
        if ('label' in control) {
          td.appendChild(control.label)
        }
        tr.appendChild(td)
      }
      this.parameterstable.appendChild(tr)
    }
  }
}
