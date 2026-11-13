/*
 * pair-client.js —— pair 设备互连浏览器公共库（方案 docs/aiti-bridge-pair-plan.md）
 *
 * 头部内嵌 QR Code Generator for JavaScript (c) 2009 Kazuhiko Arase — MIT
 * （vendored qrcode-generator@1.4.4 算法主体，IIFE 直挂 __QRCodeLib，UTF-8 已注册）
 */
var __QRCodeLib = (function () {
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\u0020width="';
      img += size;
      img += '"';
      img += '\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();
  return qrcode;
})();
if (__QRCodeLib && __QRCodeLib.stringToBytesFuncs && __QRCodeLib.stringToBytesFuncs['UTF-8']) {
  __QRCodeLib.stringToBytes = __QRCodeLib.stringToBytesFuncs['UTF-8'];
}

/**
 * pair-client.js —— pair 设备互连浏览器公共库（方案 docs/aiti-bridge-pair-plan.md）
 *
 * 与 aiwin.js 同层的浏览器端模块：协议对接（register/SSE/消息/文件分块上传下载/inbox 恢复）
 * + 完整 widget UI（设备列表/聊天流/文件收发）。一份实现四处复用：
 *   - pair.html     手机/外部浏览器独立轻页（AitiPair.mount(document.body) 一行）
 *   - cockpit.html  工具条 ✉ 按钮 → 弹层 mount
 *   - aiwin 适配端  opts.pair hook（headless 实例透出 aiwin.getPair()）
 *   - pi-web 扩展   aiti-pair 面板挂 widget
 *
 * 依赖：无（自带 fetch/SSE 直连桥 /bridge/pair/*；不依赖 bridge-client.js / host-protocol.js）
 *
 * 用法：
 *   // widget（一行接入）
 *   const pair = window.AitiPair.mount(el, { base: 'https://host/aiti', name: '张三的手机' });
 *   // headless（只要协议不要 UI）
 *   const p2 = window.AitiPair.create({ base });
 *   p2.on('message', m => …); p2.on('file', m => …); p2.on('devices', list => …);
 *   await p2.sendText('<deviceId>|all', 'hi'); await p2.sendFile('<deviceId>', file);
 *
 * 可达域：单个桥实例内的设备集合（连同一个桥即互发）；设备列表 = page/agent/pair 三类统一视图。
 */
(function (global) {
  'use strict';

  var CHUNK = 1024 * 1024; // 上传分块 1MB（服务端上限 2MB；≤1MB 不触 nginx client_max_body_size 常见默认）
  var STORE_KEY = '__aiti_pair_cred:'; // + base（peerId/token 持久化：刷新幂等）

  function createPair(opts) {
    opts = opts || {};
    var base = String(opts.base || inferBase()).replace(/\/+$/, '');
    var listeners = {}; // event -> [cb]
    var peerId = opts.peerId || null;
    var token = null;
    var myName = opts.name || null;
    var es = null;
    var started = false;
    var disposed = false;
    var devices = [];      // 统一设备视图（page/agent/pair）
    var history = [];      // 聊天流（inbox 恢复 + 实时；本端发出的也 push）
    var reconnectTimer = null;
    var reconnectAttempt = 0;
    var sseReady = false;

    function inferBase() {
      var path = String(global.location && global.location.pathname || '');
      // pi-web 内嵌桥：扩展 serve 的 pair.html → 桥端点前缀 <basePath>/api/extensions/aiti-devtools/mcp
      // （extId 即 aiti-devtools；slice 保住 /dev 等 basePath 前缀）
      var i = path.indexOf('/api/extensions/aiti-devtools/');
      if (i >= 0) return global.location.origin + path.slice(0, i) + '/api/extensions/aiti-devtools/mcp';
      return global.location.origin + (path.indexOf('/aiti/') === 0 ? '/aiti' : '');
    }
    function emit(ev, data) { (listeners[ev] || []).forEach(function (cb) { try { cb(data); } catch (e) {} }); }
    function on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return function () { listeners[ev] = (listeners[ev] || []).filter(function (x) { return x !== cb; }); }; }

    function loadCred() {
      try {
        var v = global.localStorage.getItem(STORE_KEY + base);
        if (v) { var o = JSON.parse(v); peerId = o.peerId || null; token = o.token || null; if (!myName && o.name) myName = o.name; }
      } catch (e) {}
    }
    function saveCred() {
      try { global.localStorage.setItem(STORE_KEY + base, JSON.stringify({ peerId: peerId, token: token, name: myName })); } catch (e) {}
    }

    /** 手机/新设备入口链接（QR 内容 + 复制链接同源）。
     *  pi-web 内嵌桥（base 相对，可带 basePath）→ 完整工作台 URL + ?pair=1 深链：打开 AI 窗口
     *  即自动弹出设备互连面板，与桌面「先开 pi-web → 点设备互连」同体验（aiti-pair 客户端消费该参数）；
     *  独立桥（base 绝对）→ pair.html 独立轻页（桥自身无工作台）。 */
    function pairPageUrl() {
      var p = base.replace(/\/mcp$/, '');
      if (p.charAt(0) === '/') {
        var root = p.split('/api/extensions')[0];
        var origin = global.location && global.location.origin ? global.location.origin : '';
        return origin + root + '/?pair=1';
      }
      return p + '/pair.html';
    }

    /** QR SVG 生成（__QRCodeLib vendor；sizePx 控制显示尺寸） */
    function qrSvgTag(sizePx) {
      try {
        var lib = global.__QRCodeLib;
        if (!lib) return '<div style="font-size:10px;color:var(--ap-dim)">QR 库未加载</div>';
        var qr = lib(0, 'M');
        qr.addData(pairPageUrl());
        qr.make();
        var svg = qr.createSvgTag({ cellSize: 4, margin: 2 });
        return svg.replace('<svg', '<svg style="width:' + sizePx + 'px;height:' + sizePx + 'px"');
      } catch (e) { return '<div style="font-size:10px;color:var(--ap-dim)">QR 生成失败</div>'; }
    }

    function http(path, body, rawBody) {
      var init = body || rawBody ? { method: 'POST', headers: rawBody ? {} : { 'Content-Type': 'application/json' }, body: rawBody || JSON.stringify(body) } : {};
      return fetch(base + path, init).then(function (r) { return r.json().catch(function () { return null; }); })
        .catch(function () { return null; });
    }

    // ---- 设备信息采集（pair.html / widget 注册上报；与 launcher device 同字段） ----
    function collectDevice() {
      try {
        var ua = global.navigator ? global.navigator.userAgent : '';
        var browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '?';
        var os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '?';
        var scr = global.screen ? (global.screen.width + 'x' + global.screen.height) : '';
        var lang = global.navigator ? (global.navigator.language || '') : '';
        return { browser: browser, os: os, screen: scr, lang: lang, dpr: global.devicePixelRatio || 1 };
      } catch (e) { return null; }
    }

    // ---- 注册（幂等：peerId 已知则服务端复用 token/身份） ----
    function register() {
      loadCred();
      var body = { peerId: peerId, name: myName || defaultName(), ua: global.navigator ? global.navigator.userAgent.slice(0, 200) : '', device: collectDevice() };
      return http('/bridge/pair/register', body).then(function (r) {
        if (!r || !r.ok) throw new Error('register 失败');
        peerId = r.peerId; token = r.token;
        saveCred();
        return r;
      });
    }
    function defaultName() {
      var ua = global.navigator ? global.navigator.userAgent : '';
      var os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '设备';
      var br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
      return os + (br ? ' · ' + br : '');
    }

    // ---- SSE（自带重连 + 解冻锚点，手机后台冻结恢复） ----
    function connect() {
      if (!peerId || !token || disposed) return;
      try { if (es) es.close(); } catch (e) {}
      sseReady = false;
      es = new EventSource(base + '/bridge/pair/events?peer=' + encodeURIComponent(peerId) + '&token=' + encodeURIComponent(token));
      es.onopen = function () { reconnectAttempt = 0; emit('status', { state: 'connected' }); };
      es.onerror = function () {
        sseReady = false;
        emit('status', { state: 'reconnecting' });
        scheduleReconnect();
      };
      es.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        handleMessage(m);
      };
    }
    function scheduleReconnect() {
      if (reconnectTimer || disposed || !base) return;
      var delay = Math.min(15000, 500 * Math.pow(2, reconnectAttempt++));
      reconnectTimer = setTimeout(function () { reconnectTimer = null; if (!disposed) connect(); }, delay);
    }
    function handleMessage(m) {
      if (!m) return;
      if (m.type === 'ready') { sseReady = true; refreshDevices(); refreshInbox(); return; }
      if (m.type === 'text' || m.type === 'file') { pushHistory(m, false); emit(m.type, m); emit('message', m); return; }
      if (m.type === 'devices' || m.type === 'peer-join' || m.type === 'peer-leave') { refreshDevices(); return; }
    }

    // ---- 设备列表 / 收件箱（事件驱动：ready/peer 变化/解冻时拉；无轮询） ----
    function refreshDevices() {
      return fetch(base + '/bridge/pair/devices').then(function (r) { return r.json(); }).then(function (b) {
        if (b && b.devices) { devices = b.devices; emit('devices', devices); }
        return devices;
      }).catch(function () { return devices; });
    }
    function refreshInbox() {
      if (!peerId || !token) return Promise.resolve();
      return fetch(base + '/bridge/pair/inbox?peer=' + encodeURIComponent(peerId) + '&token=' + encodeURIComponent(token))
        .then(function (r) { return r.json(); }).then(function (b) {
          if (b && b.ok && b.pending && b.pending.length) {
            b.pending.forEach(function (m) { pushHistory(m, false); emit(m.type, m); emit('message', m); });
            emit('inbox', b.pending);
          }
        }).catch(function () {});
    }

    // ---- 发送 ----
    function sendText(to, text) {
      if (!token) return Promise.reject(new Error('未注册'));
      return http('/bridge/pair/message', { peer: peerId, token: token, to: to || 'all', text: String(text || '') }).then(function (r) {
        if (!r) throw new Error('发送失败（网络）');
        if (r.ok) {
          var env = { id: 'local_' + Date.now(), type: 'text', from: { id: peerId, kind: 'pair', name: myName }, to: to || 'all', text: String(text), ts: Date.now() };
          pushHistory(env, true);
        }
        return r;
      });
    }

    function sendFile(to, file, onProgress) {
      if (!token) return Promise.reject(new Error('未注册'));
      var mime = file.type || 'application/octet-stream';
      return http('/bridge/pair/file/init', { peer: peerId, token: token, to: to || 'all', name: file.name, size: file.size, mime: mime }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || 'init 失败');
        var fileId = r.fileId;
        var off = 0;
        function next() {
          if (off >= file.size) return complete();
          var slice = file.slice(off, Math.min(off + CHUNK, file.size));
          return fetch(base + '/bridge/pair/file/chunk/' + fileId + '?n=' + Math.floor(off / CHUNK), { method: 'POST', body: slice })
            .then(function (resp) { return resp.json().catch(function () { return null; }); })
            .then(function (cr) {
              if (!cr || cr.error) throw new Error((cr && cr.error) || 'chunk 失败');
              off = cr.bytes;
              if (onProgress) { try { onProgress(off, file.size); } catch (e) {} }
              return next();
            });
        }
        function complete() {
          return http('/bridge/pair/file/complete/' + fileId, {}).then(function (cr) {
            if (!cr || !cr.ok) throw new Error((cr && cr.error) || 'complete 失败');
            pushHistory({ id: 'local_' + Date.now(), type: 'file', from: { id: peerId, kind: 'pair', name: myName }, to: to || 'all', file: { fileId: fileId, name: file.name, size: file.size, mime: mime }, ts: Date.now() }, true);
            return { fileId: fileId };
          });
        }
        return next();
      });
    }

    function fileUrl(fileId) {
      return base + '/bridge/pair/file/' + encodeURIComponent(fileId) + '?peer=' + encodeURIComponent(peerId) + '&token=' + encodeURIComponent(token);
    }

    function pushHistory(env, mine) {
      env.mine = !!mine || (env.from && env.from.id === peerId);
      history.push(env);
      if (history.length > 500) history.splice(0, history.length - 500);
      emit('history', history);
    }

    // ---- 解冻锚点（手机后台冻结 SSE 被杀 → 回前台重建；照 bridge-client 同款三锚点） ----
    function armThawHooks() {
      if (typeof document === 'undefined' || !document.addEventListener) return;
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && started) { thaw(); }
      });
      global.addEventListener('pageshow', function (e) { if (e.persisted && started) thaw(); });
      global.addEventListener('online', function () { if (started) thaw(); });
    }
    function thaw() {
      if (disposed || !started) return;
      if (es && es.readyState === 0) return; // CONNECTING 中
      if (!es || es.readyState === 2 || !sseReady) { connect(); return; }
      // 探活：devices GET 一次（顺带刷新设备列表，非轮询）
      fetch(base + '/bridge/pair/devices', { cache: 'no-store' }).then(function (r) { if (!r.ok) connect(); else refreshDevices(); }).catch(function () { connect(); });
    }
    armThawHooks();

    function setName(name) {
      myName = String(name || '').slice(0, 40) || myName;
      saveCred();
      return register();
    }
    function getName() { return myName; }
    function getDevices() { return devices; }
    function getHistory() { return history; }

    function start() {
      if (started) return Promise.resolve();
      started = true;
      return register().then(function (r) {
        if (!myName && r && r.name) { myName = r.name; saveCred(); } // 首次自动命名：回填实际注册名（widget 输入框/headless getName 可见）
        connect(); refreshDevices(); refreshInbox();
      });
    }
    function stop() {
      disposed = true;
      started = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { if (es) es.close(); } catch (e) {}
    }

    return { start: start, stop: stop, on: on, sendText: sendText, sendFile: sendFile, fileUrl: fileUrl, pairPageUrl: pairPageUrl, qrSvgTag: qrSvgTag, setName: setName, getName: getName, getDevices: getDevices, getHistory: getHistory, getPeerId: function () { return peerId; }, isConnected: function () { return sseReady; } };
  }

  // ================= widget UI（mount；pair.html / cockpit / pi-web 扩展共用） =================
  // 主题自适配：mount 时从宿主 documentElement 读 CSS 变量（pi-web --text/--bg-panel/--accent、
  // cockpit --text/--panel 同名命中；独立 pair.html 无宿主变量 → 内置浅色兜底）。
  var WIDGET_CSS = [
    '.apair{position:relative;width:100%;display:flex;flex-direction:column;height:100%;min-height:0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ap-fg);background:var(--ap-panel)}',
    '.apair *,.apair *::before,.apair *::after{box-sizing:border-box}',
    '.apair ::-webkit-scrollbar{width:8px;height:8px}',
    '.apair ::-webkit-scrollbar-thumb{background:var(--ap-line);border-radius:4px}',
    '.apair ::-webkit-scrollbar-thumb:hover{background:var(--ap-dim)}',
    // ---- 头部：状态点 + 本端名（ghost 输入）+ 设备数 ----
    '.apair-head{display:flex;align-items:center;gap:9px;padding:9px 12px;border-bottom:1px solid var(--ap-line);flex-shrink:0}',
    '.apair-dot{width:8px;height:8px;border-radius:50%;background:#10b981;flex-shrink:0;box-shadow:0 0 0 3px rgba(16,185,129,.16)}',
    '.apair-dot.mid{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.16);animation:ap-pulse 1.2s ease-in-out infinite}',
    '.apair-dot.off{background:#9ca3af;box-shadow:none;animation:none}',
    '@keyframes ap-pulse{50%{opacity:.35}}',
    '.apair-name{flex:0 1 auto;width:158px;min-width:0;background:transparent;border:1px solid transparent;border-radius:7px;color:var(--ap-fg);padding:3px 8px;font:inherit;font-weight:600;transition:border-color .12s,background .12s}',
    '.apair-name:hover{border-color:var(--ap-line)}',
    '.apair-name:focus{outline:none;border-color:var(--ap-accent);background:var(--ap-panel)}',
    '.apair-head .sp{flex:1;min-width:0}',
    '.apair-count{font-size:10px;color:var(--ap-dim);background:var(--ap-surface);border-radius:9px;padding:2px 9px;white-space:nowrap}',
    '.apair-hbtn{background:transparent;border:1px solid transparent;border-radius:7px;color:var(--ap-dim);cursor:pointer;font:inherit;font-size:13px;padding:3px 6px;line-height:1;flex-shrink:0;transition:color .12s,border-color .12s}',
    '.apair-hbtn:hover{color:var(--ap-fg);border-color:var(--ap-line)}',
    // ---- 侧栏设备列表 ----
    '.apair-body{display:flex;flex:1;min-height:0}',
    '.apair-side{width:176px;flex-shrink:0;border-right:1px solid var(--ap-line);overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:2px;background:var(--ap-page)}',
    '.apair-sidehd{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--ap-dim);padding:2px 4px 6px 8px;text-transform:uppercase;letter-spacing:.06em}',
    '.apair-sidehd .t{flex:1;min-width:0}',
    '.apair-flt{background:transparent;border:1px solid transparent;border-radius:5px;color:var(--ap-dim);cursor:pointer;font:inherit;font-size:9px;padding:2px 6px;line-height:1;flex-shrink:0;letter-spacing:0;transition:color .12s,border-color .12s}',
    '.apair-flt:hover{color:var(--ap-fg);border-color:var(--ap-line)}',
    '.apair-flt.on{color:var(--ap-accent);border-color:var(--ap-accent)}',
    '.apair-dev{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;min-width:0;border:1px solid transparent;transition:background .12s}',
    '.apair-dev:hover{background:var(--ap-surface)}',
    '.apair-dev.sel{background:var(--ap-accent-soft)}',
    '.apair-dev.sel .nm{color:var(--ap-accent);font-weight:600}',
    '.apair-dev .ic{width:26px;height:26px;border-radius:8px;background:var(--ap-panel);border:1px solid var(--ap-line);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}',
    '.apair-dev .nmc{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
    '.apair-dev .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;flex-shrink:0}',
    '.apair-dev .nm-info{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:9px;color:var(--ap-dim)}',
    '.apair-dev.off .nm{opacity:.55}',
    '.apair-dev .dot{width:6px;height:6px;border-radius:50%;background:#10b981;flex-shrink:0}',
    '.apair-dev .dot.off{background:#cbd5e1}',
    '.apair-dev .kd{font-size:9px;color:var(--ap-dim);flex-shrink:0;letter-spacing:.04em}',
    // ---- 消息区：气泡 + 时间戳 ----
    '.apair-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--ap-page)}',
    '.apair-msgs{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px;min-height:0}',
    '.apair-msg{max-width:78%;display:flex;flex-direction:column;gap:3px;animation:ap-in .18s ease-out}',
    '@keyframes ap-in{from{opacity:0;transform:translateY(4px)}}',
    '.apair-msg.mine{align-self:flex-end;align-items:flex-end}',
    '.apair-bub{padding:7px 11px;border-radius:12px;background:var(--ap-panel);border:1px solid var(--ap-line);word-break:break-word;white-space:pre-wrap;box-shadow:0 1px 2px rgba(0,0,0,.04)}',
    '.apair-msg.mine .apair-bub{background:var(--ap-accent);border-color:transparent;color:var(--ap-accent-c);border-bottom-right-radius:4px}',
    '.apair-msg:not(.mine) .apair-bub{border-bottom-left-radius:4px}',
    '.apair-who{font-size:10px;color:var(--ap-dim);padding:0 4px}',
    '.apair-meta{font-size:9px;color:var(--ap-dim);padding:0 4px}',
    // ---- 文件卡 ----
    '.apair-file{display:flex;align-items:center;gap:9px;min-width:190px}',
    '.apair-file .fic{width:32px;height:32px;border-radius:8px;background:var(--ap-surface);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}',
    '.apair-msg.mine .apair-file .fic{background:rgba(255,255,255,.2)}',
    '.apair-file .fm{flex:1;min-width:0}',
    '.apair-file .fn{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.apair-file .fs{font-size:10px;color:var(--ap-dim)}',
    '.apair-msg.mine .apair-file .fs{color:inherit;opacity:.7}',
    '.apair-file .fb{flex-shrink:0;border:1px solid var(--ap-line);border-radius:7px;padding:4px 10px;font-size:11px;color:var(--ap-accent);cursor:pointer;text-decoration:none;background:var(--ap-panel)}',
    '.apair-file .fb:hover{border-color:var(--ap-accent)}',
    // ---- 空态 ----
    '.apair-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--ap-dim);font-size:12px;padding:26px 16px;text-align:center}',
    '.apair-empty .big{font-size:30px;opacity:.55}',
    // ---- 进度条 ----
    '.apair-prog{display:none;align-items:center;gap:9px;padding:7px 12px;font-size:11px;color:var(--ap-muted);border-top:1px solid var(--ap-line);flex-shrink:0;background:var(--ap-panel)}',
    '.apair-prog.show{display:flex}',
    '.apair-prog .t{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.apair-prog .bar{flex:1;height:4px;border-radius:2px;background:var(--ap-surface);overflow:hidden}',
    '.apair-prog .bar i{display:block;height:100%;background:var(--ap-accent);border-radius:2px;transition:width .15s}',
    // ---- 输入区 ----
    '.apair-comp{display:flex;gap:8px;padding:10px;border-top:1px solid var(--ap-line);flex-shrink:0;align-items:flex-end;background:var(--ap-panel)}',
    '.apair-comp textarea{flex:1;resize:none;background:var(--ap-page);border:1px solid var(--ap-line);border-radius:10px;color:var(--ap-fg);padding:8px 10px;font:inherit;min-height:37px;max-height:110px;transition:border-color .12s,box-shadow .12s}',
    '.apair-comp textarea:focus{outline:none;border-color:var(--ap-accent);box-shadow:0 0 0 3px var(--ap-accent-soft)}',
    '.apair-btn{background:var(--ap-panel);border:1px solid var(--ap-line);border-radius:9px;color:var(--ap-fg);padding:7px 12px;cursor:pointer;font:inherit;white-space:nowrap;transition:border-color .12s,filter .12s}',
    '.apair-btn:hover{border-color:var(--ap-dim)}',
    '.apair-btn.primary{background:var(--ap-accent);color:var(--ap-accent-c);border-color:transparent}',
    '.apair-btn.primary:hover{border-color:transparent;filter:brightness(1.08)}',
    '.apair-btn:disabled{opacity:.5;cursor:default}',
    // ---- 小屏（≤640）：抽屉式设备列表 + 头部紧凑 + 防横向溢出 ----
    '.apair-hbtn.side-tgl{display:none}',
    // ---- 大屏：侧栏加宽 + 气泡收窄 + 留白升级（配 aiti-pair 面板 720/900 响应式默认尺寸） ----
    '@media (min-width:1024px){.apair-side{width:212px}.apair-msg{max-width:74%}.apair-msgs{padding:16px 14px}.apair-head{padding:10px 14px}}',
    '@media (min-width:1536px){.apair-side{width:244px}.apair-msgs{padding:18px 16px}.apair-empty .big{font-size:36px}}',
    '@media (max-width:640px){',
    '  .apair-head{gap:6px;padding:8px 10px}',
    '  .apair-name{width:auto;flex:1;min-width:0}',
    '  .apair-count{display:none}',
    '  .apair-hbtn.side-tgl{display:inline-flex}',
    '  .apair-side{position:absolute;top:0;bottom:0;left:0;width:min(240px,80vw);transform:translateX(-103%);transition:transform .16s ease;z-index:6;box-shadow:10px 0 28px rgba(0,0,0,.14)}',
    '  .apair.side-open .apair-side{transform:none}',
    '  .apair-comp{gap:6px;padding:8px}',
    '  .apair-comp textarea{min-width:0}',
    '  .apair-msg{max-width:88%}',
    '  .apair-side svg{max-width:100%;height:auto !important}', // 空态内嵌 QR(inline 160px)收缩进抽屉
    '}',
  ].join('\n');

  /** 从宿主 documentElement 收集主题变量（缺省浅色兜底）；挂到 widget 根上局部生效 */
  function themeVars() {
    var cs = getComputedStyle(document.documentElement);
    function pick(names, fb) {
      for (var i = 0; i < names.length; i++) { var v = (cs.getPropertyValue(names[i]) || '').trim(); if (v) return v; }
      return fb;
    }
    var tv = {
      '--ap-fg': pick(['--text'], '#0f172a'),
      '--ap-muted': pick(['--text-muted', '--muted'], '#64748b'),
      '--ap-dim': pick(['--text-dim', '--dim'], '#94a3b8'),
      '--ap-line': pick(['--border'], '#e2e8f0'),
      '--ap-panel': pick(['--bg-panel', '--panel'], '#ffffff'),
      '--ap-surface': pick(['--bg-hover', '--panel2'], '#f1f5f9'),
      '--ap-page': pick(['--bg', '--panel2'], '#f8fafc'),
      '--ap-accent': pick(['--accent'], '#2563eb'),
      '--ap-accent-c': pick(['--accent-contrast'], '#ffffff'),
      '--ap-accent-soft': pick(['--accent-soft'], 'rgba(37,99,235,.10)'),
    };
    return tv;
  }

  function mountWidget(el, opts) {
    opts = opts || {};
    var p = createPair(opts);
    var cssId = 'apair-css';
    if (!document.getElementById(cssId)) {
      var st = document.createElement('style'); st.id = cssId; st.textContent = WIDGET_CSS;
      document.head.appendChild(st);
    }
    el.innerHTML = [
      '<div class="apair">',
      '  <div class="apair-head">',
      '    <button class="apair-hbtn side-tgl" data-act="side" title="设备列表">👥</button>',
      '    <span class="apair-dot"></span>',
      '    <input class="apair-name" title="本端设备名（回车保存）" />',
      '    <span class="sp"></span>',
      '    <button class="apair-hbtn" data-act="phone" title="复制手机入口链接（同当前访问地址）">📱</button>',
      '    <button class="apair-hbtn" data-act="export" title="导出聊天记录（Markdown）">⬇</button>',
      '    <span class="apair-count"></span>',
      '  </div>',
      '  <div class="apair-body">',
      '    <div class="apair-side"></div>',
      '    <div class="apair-main">',
      '      <div class="apair-msgs"></div>',
      '      <div class="apair-prog"><span class="t"></span><div class="bar"><i style="width:0%"></i></div></div>',
      '      <div class="apair-comp">',
      '        <button class="apair-btn" data-act="file" title="发送文件">📎</button>',
      '        <textarea placeholder="发消息…（Enter 发送，Shift+Enter 换行）"></textarea>',
      '        <button class="apair-btn primary" data-act="send">发送</button>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <input type="file" multiple style="display:none" />',
      '</div>',
    ].join('');
    var root = el.querySelector('.apair');
    var tv = themeVars();
    for (var k in tv) root.style.setProperty(k, tv[k]);
    var dotEl = el.querySelector('.apair-dot');
    var nameInput = el.querySelector('.apair-name');
    var countEl = el.querySelector('.apair-count');
    var sideEl = el.querySelector('.apair-side');
    var msgsEl = el.querySelector('.apair-msgs');
    var progEl = el.querySelector('.apair-prog');
    var progT = progEl.querySelector('.t');
    var progBar = progEl.querySelector('.bar i');
    var ta = el.querySelector('textarea');
    var fileInput = el.querySelector('input[type=file]');
    var target = 'all'; // 发送目标：设备 id 或 'all'
    var icon = { page: '🖥', agent: '🤖', pair: '📱' };
    var esc = function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

    function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'; }
    function fmtTime(ts) {
      var d = new Date(typeof ts === 'number' ? ts : (Date.parse(ts) || Date.now()));
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    function targetName(id) {
      if (id === 'all') return '全部设备';
      var all = p.getDevices();
      var d = all.filter(function (x) { return x.id === id; })[0];
      if (!d) return String(id || '').slice(0, 12);
      // 同名歧义时占位符也带 id 尾标（与列表消歧一致）
      var same = all.filter(function (x) { return x.name === d.name; }).length;
      return d.name + (same > 1 ? ' ·' + String(d.id).slice(-4) : '');
    }

    // 离线显示偏好（默认只显在线；持久化 localStorage）
    var showOffline = false;
    try { showOffline = global.localStorage.getItem('__aiti_pair_showOffline') === '1'; } catch (e) {}
    function setShowOffline(v) {
      showOffline = !!v;
      try { global.localStorage.setItem('__aiti_pair_showOffline', showOffline ? '1' : '0'); } catch (e) {}
      renderDevices();
    }

    function renderDevices() {
      var all = p.getDevices().filter(function (d) { return d.id !== p.getPeerId(); });
      var online = all.filter(function (d) { return d.online !== false; });
      countEl.textContent = online.length + ' / ' + all.length + ' 台在线';
      // 默认只显在线；"显示离线"开启才列出。选中的目标即使离线/被过滤也保持可见（发送目标上下文不丢）
      var list = showOffline ? all : all.filter(function (d) { return d.online !== false || d.id === target; });
      var rows = ['<div class="apair-sidehd"><span class="t">设备</span>'
        + '<button class="apair-flt' + (showOffline ? ' on' : '') + '" data-act="flt" title="' + (showOffline ? '隐藏离线设备' : '显示离线设备') + '">' + (showOffline ? '全部' : '在线') + '</button></div>'];
      rows.push('<div class="apair-dev' + (target === 'all' ? ' sel' : '') + '" data-id="all" title="群发：全部 pair 设备与 agent">'
        + '<span class="ic">📡</span><span class="nm">全部</span></div>');
      if (!list.length) {
        rows.push('<div style="font-size:11px;color:var(--ap-dim);padding:8px 4px;text-align:center;line-height:1.6">暂无在线设备<br>手机扫下方二维码接入 ↓</div>');
        rows.push('<div class="apair-dev" data-id="__qr__" style="cursor:default"><div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px">'
          + p.qrSvgTag(160)
          + '<span style="font-size:9px;color:var(--ap-dim);word-break:break-all;text-align:center">' + esc(p.pairPageUrl()) + '</span>'
          + '</div></div>');
      } else {
        // 同名消歧：同默认名的设备（多标签/多来源/同 CLI 多会话）追加 id 尾标区分，
        // 否则列表看起来全是重复项（name 相同时 cwd 副标题窄屏又看不见）
        var nameCount = {};
        list.forEach(function (d) { nameCount[d.name] = (nameCount[d.name] || 0) + 1; });
        list.forEach(function (d) {
          var on = d.online !== false;
          var info = d.deviceLabel || d.cwd || '';
          var dup = nameCount[d.name] > 1;
          var nm = d.name + (dup ? ' <span style="color:var(--ap-dim);font-weight:400">·' + esc(String(d.id).slice(-4)) + '</span>' : '');
          rows.push('<div class="apair-dev' + (d.id === target ? ' sel' : '') + (!on ? ' off' : '') + '" data-id="' + esc(d.id) + '" title="' + esc(d.name) + (info ? ' · ' + info : '') + (on ? '' : '（离线）') + '">'
            + '<span class="ic">' + (icon[d.kind] || '•') + '</span>'
            + '<span class="nmc"><span class="nm">' + nm + '</span>'
            + (info ? '<span class="nm-info">' + esc(info.slice(0, 40)) + '</span>' : '')
            + '</span>'
            + '<span class="dot' + (!on ? ' off' : '') + '"></span>'
            + '<span class="kd">' + esc(d.kind) + '</span></div>');
        });
      }
      sideEl.innerHTML = rows.join('');
      ta.placeholder = '发消息给 ' + targetName(target) + '…';
    }
    sideEl.addEventListener('click', function (e) {
      var flt = e.target.closest && e.target.closest('[data-act=flt]');
      if (flt) { setShowOffline(!showOffline); return; }
      var row = e.target.closest && e.target.closest('.apair-dev');
      if (!row) return;
      // QR 占位行不是发送目标——误点会把 target 静默改成 __qr__（消息从此发丢）
      if (row.getAttribute('data-id') === '__qr__') return;
      target = row.getAttribute('data-id');
      renderDevices();
      // 小屏抽屉：选中设备即收起（mobileMq 与 CSS 媒体块同阈值；非小屏 no-op）
      if (mobileMq && mobileMq.matches) root.classList.remove('side-open');
    });

    function renderMsgs() {
      var hist = p.getHistory();
      if (!hist.length) {
        msgsEl.innerHTML = '<div class="apair-empty"><div class="big">💬</div><div>消息零服务端留存：设备在线直投<br>掉线短暂排队（拉取即清）</div></div>';
        return;
      }
      msgsEl.innerHTML = hist.map(function (m) {
        var mine = !!m.mine;
        var time = fmtTime(m.ts);
        var inner;
        if (m.type === 'file' && m.file) {
          inner = '<div class="apair-file"><span class="fic">📄</span><div class="fm"><div class="fn">' + esc(m.file.name) + '</div><div class="fs">' + fmtSize(m.file.size) + ' · ' + esc(targetName(m.to)) + '</div></div>'
            + (mine ? '' : '<span class="fb" data-fid="' + esc(m.file.fileId) + '" data-fn="' + esc(m.file.name) + '">保存</span>') + '</div>';
        } else {
          inner = '<div class="apair-bub">' + esc(m.text || '') + '</div>';
        }
        var who = mine ? '' : '<div class="apair-who">' + esc((m.from && m.from.name) || '?') + ' → ' + esc(targetName(m.to)) + '</div>';
        return '<div class="apair-msg' + (mine ? ' mine' : '') + '">' + who + inner + '<div class="apair-meta">' + time + '</div></div>';
      }).join('');
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
    msgsEl.addEventListener('click', function (e) {
      var fb = e.target.closest && e.target.closest('.fb');
      if (!fb) return;
      var a = document.createElement('a');
      a.href = p.fileUrl(fb.getAttribute('data-fid'));
      a.download = fb.getAttribute('data-fn') || '';
      document.body.appendChild(a); a.click(); a.remove();
    });

    function toast_(text) {
      progEl.classList.add('show');
      progT.textContent = text;
      progBar.style.width = '0%';
      clearTimeout(toast_._t);
      toast_._t = setTimeout(function () { progEl.classList.remove('show'); }, 4000);
    }

    /** 📱 扫码面板：二维码 + URL + 复制（QR 内容 = 工作台深链 / pair 入口；大屏 QR 放大） */
    function toggleQrPanel() {
      var existing = document.getElementById('apair-qr-panel');
      if (existing) { existing.remove(); return; }
      var big = global.matchMedia && global.matchMedia('(min-width:1024px)').matches;
      var url = p.pairPageUrl();
      var svg = p.qrSvgTag(big ? 240 : 180);
      var panel = document.createElement('div');
      panel.id = 'apair-qr-panel';
      panel.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:16px';
      panel.innerHTML = '<div style="background:var(--ap-panel,#fff);border-radius:12px;padding:18px;display:flex;flex-direction:column;align-items:center;gap:10px;max-width:92vw">'
        + '<div style="font-size:13px;font-weight:600;color:var(--ap-fg,#111)">📱 手机扫码接入</div>'
        + (svg || '<div style="font-size:12px;color:var(--ap-dim)">QR 生成失败</div>')
        + '<div style="font-size:11px;color:var(--ap-muted,#666);word-break:break-all;text-align:center;max-width:' + (big ? '420px' : '260px') + '">' + esc(url) + '</div>'
        + '<button class="apair-btn primary" data-act="qr-copy">复制链接</button>'
        + '<button class="apair-btn" data-act="qr-close">关闭</button>'
        + '</div>';
      document.body.appendChild(panel);
      panel.addEventListener('click', function (e) {
        if (e.target === panel) { panel.remove(); return; }
        var act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'qr-close') panel.remove();
        if (act === 'qr-copy') {
          try { navigator.clipboard.writeText(url).then(function () { toast_('✓ 已复制'); }, function () { toast_('复制失败——请手动输入'); }); } catch (err) { toast_(url); }
        }
      });
    }

    function exportMd() {
      var hist = p.getHistory();
      if (!hist.length) { toast_('没有可导出的消息'); return; }
      var lines = ['# pair 聊天导出', '', '- 导出时间：' + new Date().toLocaleString(), '- 本端：' + (p.getName() || '?'), ''];
      hist.forEach(function (m) {
        var time = new Date(m.ts || Date.now()).toLocaleString();
        var who = m.mine ? '我' : ((m.from && m.from.name) || '?');
        var to = targetName(m.to);
        if (m.type === 'file' && m.file) lines.push('- **[' + time + '] ' + who + ' → ' + to + '** · 📄 ' + m.file.name + '（' + fmtSize(m.file.size) + '）');
        else lines.push('- **[' + time + '] ' + who + ' → ' + to + '**：' + String(m.text || '').replace(/\n/g, '\n  '));
      });
      var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pair-chat-' + new Date().toISOString().slice(0, 10) + '.md';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 3000);
      toast_('✓ 已导出 ' + hist.length + ' 条（Markdown）');
    }

    function doSend() {
      var text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      // 防御：QR 占位 id 混进 target 时回退群发（正常流已在点击侧排除）
      var to = target === '__qr__' ? 'all' : target;
      p.sendText(to, text).then(function (r) {
        if (!r) { progEl.classList.add('show'); progT.textContent = '⚠ 发送失败（网络）'; progBar.style.width = '0%'; return; }
        if (r.candidates && r.candidates.length) {
          progEl.classList.add('show');
          progT.textContent = '⚠ 目标匹配多个：' + r.candidates.map(function (c) { return c.name || c.id; }).join('、');
          progBar.style.width = '0%';
        }
      }).catch(function (e) { progEl.classList.add('show'); progT.textContent = '⚠ ' + (e.message || e); });
    }
    el.querySelector('[data-act=send]').addEventListener('click', doSend);
    el.querySelector('[data-act=phone]').addEventListener('click', toggleQrPanel);
    el.querySelector('[data-act=export]').addEventListener('click', exportMd);
    el.querySelector('[data-act=side]').addEventListener('click', function () { root.classList.toggle('side-open'); });
    // 小屏抽屉：选中设备即收起（matchMedia 与 CSS 媒体块同阈值）
    var mobileMq = global.matchMedia ? global.matchMedia('(max-width:640px)') : null;
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    el.querySelector('[data-act=file]').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var files = [].slice.call(fileInput.files || []);
      fileInput.value = '';
      (function sendNext() {
        var f = files.shift();
        if (!f) { setTimeout(function () { progEl.classList.remove('show'); }, 600); return; }
        progEl.classList.add('show');
        progT.textContent = '⬆ ' + f.name;
        progBar.style.width = '0%';
        p.sendFile(target === '__qr__' ? 'all' : target, f, function (done, total) {
          progBar.style.width = Math.round((done / total) * 100) + '%';
        }).then(function () { progBar.style.width = '100%'; renderMsgs(); sendNext(); })
          .catch(function (e) { progT.textContent = '⚠ ' + f.name + '：' + (e.message || e); });
      })();
    });
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        p.setName(nameInput.value.trim()).then(function () {
          progEl.classList.add('show'); progT.textContent = '✓ 设备名已更新'; progBar.style.width = '0%';
          setTimeout(function () { progEl.classList.remove('show'); }, 1200);
          renderDevices();
        });
      }
    });

    // 浏览器通知：标签页不在前台 + 有新消息 → Notification API（首次触发权限请求）
    var notifRequested = false;
    p.on('message', function (m) {
      if (m.mine) return;
      if (document.hasFocus && document.hasFocus()) return; // 前台不通知
      try {
        if (!notifRequested && typeof global.Notification !== 'undefined' && global.Notification.permission === 'default') {
          notifRequested = true;
          global.Notification.requestPermission();
        }
        if (global.Notification && global.Notification.permission === 'granted') {
          var n = new global.Notification((m.from && m.from.name) || '设备互连', {
            body: m.type === 'file' ? '📎 ' + (m.file && m.file.name || '') : String(m.text || '').slice(0, 100),
            tag: 'apair-' + m.id,
          });
          n.onclick = function () { global.focus(); n.close(); };
          setTimeout(function () { n.close(); }, 8000);
        }
      } catch (e) {}
    });
    p.on('devices', renderDevices);
    p.on('history', renderMsgs);
    p.on('status', function (s) {
      dotEl.className = 'apair-dot' + (s.state === 'connected' ? '' : (s.state === 'reconnecting' ? ' mid' : ' off'));
      dotEl.title = s.state === 'connected' ? '已连接' : '重连中';
    });

    if (opts.name) nameInput.value = opts.name;
    p.on('devices', function () { if (!nameInput.value) nameInput.value = p.getName() || ''; });
    renderDevices();
    renderMsgs(); // 初始空态（history 事件仅在首条消息时触发）
    p.start();
    return p;
  }

  global.AitiPair = { create: createPair, mount: mountWidget };
})(window);
