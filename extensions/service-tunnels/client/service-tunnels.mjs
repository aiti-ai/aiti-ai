/* service-tunnels client bundle — built by tools/build-client.mjs (2026-08-20T06:32:06.255Z) */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/qrcode/lib/can-promise.js
var require_can_promise = __commonJS({
  "node_modules/qrcode/lib/can-promise.js"(exports, module) {
    module.exports = function() {
      return typeof Promise === "function" && Promise.prototype && Promise.prototype.then;
    };
  }
});

// node_modules/qrcode/lib/core/utils.js
var require_utils = __commonJS({
  "node_modules/qrcode/lib/core/utils.js"(exports) {
    var toSJISFunction;
    var CODEWORDS_COUNT = [
      0,
      // Not used
      26,
      44,
      70,
      100,
      134,
      172,
      196,
      242,
      292,
      346,
      404,
      466,
      532,
      581,
      655,
      733,
      815,
      901,
      991,
      1085,
      1156,
      1258,
      1364,
      1474,
      1588,
      1706,
      1828,
      1921,
      2051,
      2185,
      2323,
      2465,
      2611,
      2761,
      2876,
      3034,
      3196,
      3362,
      3532,
      3706
    ];
    exports.getSymbolSize = function getSymbolSize(version) {
      if (!version) throw new Error('"version" cannot be null or undefined');
      if (version < 1 || version > 40) throw new Error('"version" should be in range from 1 to 40');
      return version * 4 + 17;
    };
    exports.getSymbolTotalCodewords = function getSymbolTotalCodewords(version) {
      return CODEWORDS_COUNT[version];
    };
    exports.getBCHDigit = function(data) {
      let digit = 0;
      while (data !== 0) {
        digit++;
        data >>>= 1;
      }
      return digit;
    };
    exports.setToSJISFunction = function setToSJISFunction(f) {
      if (typeof f !== "function") {
        throw new Error('"toSJISFunc" is not a valid function.');
      }
      toSJISFunction = f;
    };
    exports.isKanjiModeEnabled = function() {
      return typeof toSJISFunction !== "undefined";
    };
    exports.toSJIS = function toSJIS(kanji) {
      return toSJISFunction(kanji);
    };
  }
});

// node_modules/qrcode/lib/core/error-correction-level.js
var require_error_correction_level = __commonJS({
  "node_modules/qrcode/lib/core/error-correction-level.js"(exports) {
    exports.L = { bit: 1 };
    exports.M = { bit: 0 };
    exports.Q = { bit: 3 };
    exports.H = { bit: 2 };
    function fromString(string) {
      if (typeof string !== "string") {
        throw new Error("Param is not a string");
      }
      const lcStr = string.toLowerCase();
      switch (lcStr) {
        case "l":
        case "low":
          return exports.L;
        case "m":
        case "medium":
          return exports.M;
        case "q":
        case "quartile":
          return exports.Q;
        case "h":
        case "high":
          return exports.H;
        default:
          throw new Error("Unknown EC Level: " + string);
      }
    }
    exports.isValid = function isValid(level) {
      return level && typeof level.bit !== "undefined" && level.bit >= 0 && level.bit < 4;
    };
    exports.from = function from(value, defaultValue) {
      if (exports.isValid(value)) {
        return value;
      }
      try {
        return fromString(value);
      } catch (e) {
        return defaultValue;
      }
    };
  }
});

// node_modules/qrcode/lib/core/bit-buffer.js
var require_bit_buffer = __commonJS({
  "node_modules/qrcode/lib/core/bit-buffer.js"(exports, module) {
    function BitBuffer() {
      this.buffer = [];
      this.length = 0;
    }
    BitBuffer.prototype = {
      get: function(index) {
        const bufIndex = Math.floor(index / 8);
        return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
      },
      put: function(num, length) {
        for (let i = 0; i < length; i++) {
          this.putBit((num >>> length - i - 1 & 1) === 1);
        }
      },
      getLengthInBits: function() {
        return this.length;
      },
      putBit: function(bit) {
        const bufIndex = Math.floor(this.length / 8);
        if (this.buffer.length <= bufIndex) {
          this.buffer.push(0);
        }
        if (bit) {
          this.buffer[bufIndex] |= 128 >>> this.length % 8;
        }
        this.length++;
      }
    };
    module.exports = BitBuffer;
  }
});

// node_modules/qrcode/lib/core/bit-matrix.js
var require_bit_matrix = __commonJS({
  "node_modules/qrcode/lib/core/bit-matrix.js"(exports, module) {
    function BitMatrix(size) {
      if (!size || size < 1) {
        throw new Error("BitMatrix size must be defined and greater than 0");
      }
      this.size = size;
      this.data = new Uint8Array(size * size);
      this.reservedBit = new Uint8Array(size * size);
    }
    BitMatrix.prototype.set = function(row, col, value, reserved) {
      const index = row * this.size + col;
      this.data[index] = value;
      if (reserved) this.reservedBit[index] = true;
    };
    BitMatrix.prototype.get = function(row, col) {
      return this.data[row * this.size + col];
    };
    BitMatrix.prototype.xor = function(row, col, value) {
      this.data[row * this.size + col] ^= value;
    };
    BitMatrix.prototype.isReserved = function(row, col) {
      return this.reservedBit[row * this.size + col];
    };
    module.exports = BitMatrix;
  }
});

// node_modules/qrcode/lib/core/alignment-pattern.js
var require_alignment_pattern = __commonJS({
  "node_modules/qrcode/lib/core/alignment-pattern.js"(exports) {
    var getSymbolSize = require_utils().getSymbolSize;
    exports.getRowColCoords = function getRowColCoords(version) {
      if (version === 1) return [];
      const posCount = Math.floor(version / 7) + 2;
      const size = getSymbolSize(version);
      const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
      const positions = [size - 7];
      for (let i = 1; i < posCount - 1; i++) {
        positions[i] = positions[i - 1] - intervals;
      }
      positions.push(6);
      return positions.reverse();
    };
    exports.getPositions = function getPositions(version) {
      const coords = [];
      const pos = exports.getRowColCoords(version);
      const posLength = pos.length;
      for (let i = 0; i < posLength; i++) {
        for (let j = 0; j < posLength; j++) {
          if (i === 0 && j === 0 || // top-left
          i === 0 && j === posLength - 1 || // bottom-left
          i === posLength - 1 && j === 0) {
            continue;
          }
          coords.push([pos[i], pos[j]]);
        }
      }
      return coords;
    };
  }
});

// node_modules/qrcode/lib/core/finder-pattern.js
var require_finder_pattern = __commonJS({
  "node_modules/qrcode/lib/core/finder-pattern.js"(exports) {
    var getSymbolSize = require_utils().getSymbolSize;
    var FINDER_PATTERN_SIZE = 7;
    exports.getPositions = function getPositions(version) {
      const size = getSymbolSize(version);
      return [
        // top-left
        [0, 0],
        // top-right
        [size - FINDER_PATTERN_SIZE, 0],
        // bottom-left
        [0, size - FINDER_PATTERN_SIZE]
      ];
    };
  }
});

// node_modules/qrcode/lib/core/mask-pattern.js
var require_mask_pattern = __commonJS({
  "node_modules/qrcode/lib/core/mask-pattern.js"(exports) {
    exports.Patterns = {
      PATTERN000: 0,
      PATTERN001: 1,
      PATTERN010: 2,
      PATTERN011: 3,
      PATTERN100: 4,
      PATTERN101: 5,
      PATTERN110: 6,
      PATTERN111: 7
    };
    var PenaltyScores = {
      N1: 3,
      N2: 3,
      N3: 40,
      N4: 10
    };
    exports.isValid = function isValid(mask) {
      return mask != null && mask !== "" && !isNaN(mask) && mask >= 0 && mask <= 7;
    };
    exports.from = function from(value) {
      return exports.isValid(value) ? parseInt(value, 10) : void 0;
    };
    exports.getPenaltyN1 = function getPenaltyN1(data) {
      const size = data.size;
      let points = 0;
      let sameCountCol = 0;
      let sameCountRow = 0;
      let lastCol = null;
      let lastRow = null;
      for (let row = 0; row < size; row++) {
        sameCountCol = sameCountRow = 0;
        lastCol = lastRow = null;
        for (let col = 0; col < size; col++) {
          let module2 = data.get(row, col);
          if (module2 === lastCol) {
            sameCountCol++;
          } else {
            if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
            lastCol = module2;
            sameCountCol = 1;
          }
          module2 = data.get(col, row);
          if (module2 === lastRow) {
            sameCountRow++;
          } else {
            if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
            lastRow = module2;
            sameCountRow = 1;
          }
        }
        if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
        if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
      }
      return points;
    };
    exports.getPenaltyN2 = function getPenaltyN2(data) {
      const size = data.size;
      let points = 0;
      for (let row = 0; row < size - 1; row++) {
        for (let col = 0; col < size - 1; col++) {
          const last = data.get(row, col) + data.get(row, col + 1) + data.get(row + 1, col) + data.get(row + 1, col + 1);
          if (last === 4 || last === 0) points++;
        }
      }
      return points * PenaltyScores.N2;
    };
    exports.getPenaltyN3 = function getPenaltyN3(data) {
      const size = data.size;
      let points = 0;
      let bitsCol = 0;
      let bitsRow = 0;
      for (let row = 0; row < size; row++) {
        bitsCol = bitsRow = 0;
        for (let col = 0; col < size; col++) {
          bitsCol = bitsCol << 1 & 2047 | data.get(row, col);
          if (col >= 10 && (bitsCol === 1488 || bitsCol === 93)) points++;
          bitsRow = bitsRow << 1 & 2047 | data.get(col, row);
          if (col >= 10 && (bitsRow === 1488 || bitsRow === 93)) points++;
        }
      }
      return points * PenaltyScores.N3;
    };
    exports.getPenaltyN4 = function getPenaltyN4(data) {
      let darkCount = 0;
      const modulesCount = data.data.length;
      for (let i = 0; i < modulesCount; i++) darkCount += data.data[i];
      const k = Math.abs(Math.ceil(darkCount * 100 / modulesCount / 5) - 10);
      return k * PenaltyScores.N4;
    };
    function getMaskAt(maskPattern, i, j) {
      switch (maskPattern) {
        case exports.Patterns.PATTERN000:
          return (i + j) % 2 === 0;
        case exports.Patterns.PATTERN001:
          return i % 2 === 0;
        case exports.Patterns.PATTERN010:
          return j % 3 === 0;
        case exports.Patterns.PATTERN011:
          return (i + j) % 3 === 0;
        case exports.Patterns.PATTERN100:
          return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
        case exports.Patterns.PATTERN101:
          return i * j % 2 + i * j % 3 === 0;
        case exports.Patterns.PATTERN110:
          return (i * j % 2 + i * j % 3) % 2 === 0;
        case exports.Patterns.PATTERN111:
          return (i * j % 3 + (i + j) % 2) % 2 === 0;
        default:
          throw new Error("bad maskPattern:" + maskPattern);
      }
    }
    exports.applyMask = function applyMask(pattern, data) {
      const size = data.size;
      for (let col = 0; col < size; col++) {
        for (let row = 0; row < size; row++) {
          if (data.isReserved(row, col)) continue;
          data.xor(row, col, getMaskAt(pattern, row, col));
        }
      }
    };
    exports.getBestMask = function getBestMask(data, setupFormatFunc) {
      const numPatterns = Object.keys(exports.Patterns).length;
      let bestPattern = 0;
      let lowerPenalty = Infinity;
      for (let p = 0; p < numPatterns; p++) {
        setupFormatFunc(p);
        exports.applyMask(p, data);
        const penalty = exports.getPenaltyN1(data) + exports.getPenaltyN2(data) + exports.getPenaltyN3(data) + exports.getPenaltyN4(data);
        exports.applyMask(p, data);
        if (penalty < lowerPenalty) {
          lowerPenalty = penalty;
          bestPattern = p;
        }
      }
      return bestPattern;
    };
  }
});

// node_modules/qrcode/lib/core/error-correction-code.js
var require_error_correction_code = __commonJS({
  "node_modules/qrcode/lib/core/error-correction-code.js"(exports) {
    var ECLevel = require_error_correction_level();
    var EC_BLOCKS_TABLE = [
      // L  M  Q  H
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      2,
      2,
      1,
      2,
      2,
      4,
      1,
      2,
      4,
      4,
      2,
      4,
      4,
      4,
      2,
      4,
      6,
      5,
      2,
      4,
      6,
      6,
      2,
      5,
      8,
      8,
      4,
      5,
      8,
      8,
      4,
      5,
      8,
      11,
      4,
      8,
      10,
      11,
      4,
      9,
      12,
      16,
      4,
      9,
      16,
      16,
      6,
      10,
      12,
      18,
      6,
      10,
      17,
      16,
      6,
      11,
      16,
      19,
      6,
      13,
      18,
      21,
      7,
      14,
      21,
      25,
      8,
      16,
      20,
      25,
      8,
      17,
      23,
      25,
      9,
      17,
      23,
      34,
      9,
      18,
      25,
      30,
      10,
      20,
      27,
      32,
      12,
      21,
      29,
      35,
      12,
      23,
      34,
      37,
      12,
      25,
      34,
      40,
      13,
      26,
      35,
      42,
      14,
      28,
      38,
      45,
      15,
      29,
      40,
      48,
      16,
      31,
      43,
      51,
      17,
      33,
      45,
      54,
      18,
      35,
      48,
      57,
      19,
      37,
      51,
      60,
      19,
      38,
      53,
      63,
      20,
      40,
      56,
      66,
      21,
      43,
      59,
      70,
      22,
      45,
      62,
      74,
      24,
      47,
      65,
      77,
      25,
      49,
      68,
      81
    ];
    var EC_CODEWORDS_TABLE = [
      // L  M  Q  H
      7,
      10,
      13,
      17,
      10,
      16,
      22,
      28,
      15,
      26,
      36,
      44,
      20,
      36,
      52,
      64,
      26,
      48,
      72,
      88,
      36,
      64,
      96,
      112,
      40,
      72,
      108,
      130,
      48,
      88,
      132,
      156,
      60,
      110,
      160,
      192,
      72,
      130,
      192,
      224,
      80,
      150,
      224,
      264,
      96,
      176,
      260,
      308,
      104,
      198,
      288,
      352,
      120,
      216,
      320,
      384,
      132,
      240,
      360,
      432,
      144,
      280,
      408,
      480,
      168,
      308,
      448,
      532,
      180,
      338,
      504,
      588,
      196,
      364,
      546,
      650,
      224,
      416,
      600,
      700,
      224,
      442,
      644,
      750,
      252,
      476,
      690,
      816,
      270,
      504,
      750,
      900,
      300,
      560,
      810,
      960,
      312,
      588,
      870,
      1050,
      336,
      644,
      952,
      1110,
      360,
      700,
      1020,
      1200,
      390,
      728,
      1050,
      1260,
      420,
      784,
      1140,
      1350,
      450,
      812,
      1200,
      1440,
      480,
      868,
      1290,
      1530,
      510,
      924,
      1350,
      1620,
      540,
      980,
      1440,
      1710,
      570,
      1036,
      1530,
      1800,
      570,
      1064,
      1590,
      1890,
      600,
      1120,
      1680,
      1980,
      630,
      1204,
      1770,
      2100,
      660,
      1260,
      1860,
      2220,
      720,
      1316,
      1950,
      2310,
      750,
      1372,
      2040,
      2430
    ];
    exports.getBlocksCount = function getBlocksCount(version, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case ECLevel.L:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 0];
        case ECLevel.M:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 1];
        case ECLevel.Q:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 2];
        case ECLevel.H:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 3];
        default:
          return void 0;
      }
    };
    exports.getTotalCodewordsCount = function getTotalCodewordsCount(version, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case ECLevel.L:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 0];
        case ECLevel.M:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 1];
        case ECLevel.Q:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 2];
        case ECLevel.H:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 3];
        default:
          return void 0;
      }
    };
  }
});

// node_modules/qrcode/lib/core/galois-field.js
var require_galois_field = __commonJS({
  "node_modules/qrcode/lib/core/galois-field.js"(exports) {
    var EXP_TABLE = new Uint8Array(512);
    var LOG_TABLE = new Uint8Array(256);
    (function initTables() {
      let x = 1;
      for (let i = 0; i < 255; i++) {
        EXP_TABLE[i] = x;
        LOG_TABLE[x] = i;
        x <<= 1;
        if (x & 256) {
          x ^= 285;
        }
      }
      for (let i = 255; i < 512; i++) {
        EXP_TABLE[i] = EXP_TABLE[i - 255];
      }
    })();
    exports.log = function log(n) {
      if (n < 1) throw new Error("log(" + n + ")");
      return LOG_TABLE[n];
    };
    exports.exp = function exp(n) {
      return EXP_TABLE[n];
    };
    exports.mul = function mul(x, y) {
      if (x === 0 || y === 0) return 0;
      return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
    };
  }
});

// node_modules/qrcode/lib/core/polynomial.js
var require_polynomial = __commonJS({
  "node_modules/qrcode/lib/core/polynomial.js"(exports) {
    var GF = require_galois_field();
    exports.mul = function mul(p1, p2) {
      const coeff = new Uint8Array(p1.length + p2.length - 1);
      for (let i = 0; i < p1.length; i++) {
        for (let j = 0; j < p2.length; j++) {
          coeff[i + j] ^= GF.mul(p1[i], p2[j]);
        }
      }
      return coeff;
    };
    exports.mod = function mod(divident, divisor) {
      let result = new Uint8Array(divident);
      while (result.length - divisor.length >= 0) {
        const coeff = result[0];
        for (let i = 0; i < divisor.length; i++) {
          result[i] ^= GF.mul(divisor[i], coeff);
        }
        let offset = 0;
        while (offset < result.length && result[offset] === 0) offset++;
        result = result.slice(offset);
      }
      return result;
    };
    exports.generateECPolynomial = function generateECPolynomial(degree) {
      let poly = new Uint8Array([1]);
      for (let i = 0; i < degree; i++) {
        poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]));
      }
      return poly;
    };
  }
});

// node_modules/qrcode/lib/core/reed-solomon-encoder.js
var require_reed_solomon_encoder = __commonJS({
  "node_modules/qrcode/lib/core/reed-solomon-encoder.js"(exports, module) {
    var Polynomial = require_polynomial();
    function ReedSolomonEncoder(degree) {
      this.genPoly = void 0;
      this.degree = degree;
      if (this.degree) this.initialize(this.degree);
    }
    ReedSolomonEncoder.prototype.initialize = function initialize(degree) {
      this.degree = degree;
      this.genPoly = Polynomial.generateECPolynomial(this.degree);
    };
    ReedSolomonEncoder.prototype.encode = function encode(data) {
      if (!this.genPoly) {
        throw new Error("Encoder not initialized");
      }
      const paddedData = new Uint8Array(data.length + this.degree);
      paddedData.set(data);
      const remainder = Polynomial.mod(paddedData, this.genPoly);
      const start = this.degree - remainder.length;
      if (start > 0) {
        const buff = new Uint8Array(this.degree);
        buff.set(remainder, start);
        return buff;
      }
      return remainder;
    };
    module.exports = ReedSolomonEncoder;
  }
});

// node_modules/qrcode/lib/core/version-check.js
var require_version_check = __commonJS({
  "node_modules/qrcode/lib/core/version-check.js"(exports) {
    exports.isValid = function isValid(version) {
      return !isNaN(version) && version >= 1 && version <= 40;
    };
  }
});

// node_modules/qrcode/lib/core/regex.js
var require_regex = __commonJS({
  "node_modules/qrcode/lib/core/regex.js"(exports) {
    var numeric = "[0-9]+";
    var alphanumeric = "[A-Z $%*+\\-./:]+";
    var kanji = "(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";
    kanji = kanji.replace(/u/g, "\\u");
    var byte = "(?:(?![A-Z0-9 $%*+\\-./:]|" + kanji + ")(?:.|[\r\n]))+";
    exports.KANJI = new RegExp(kanji, "g");
    exports.BYTE_KANJI = new RegExp("[^A-Z0-9 $%*+\\-./:]+", "g");
    exports.BYTE = new RegExp(byte, "g");
    exports.NUMERIC = new RegExp(numeric, "g");
    exports.ALPHANUMERIC = new RegExp(alphanumeric, "g");
    var TEST_KANJI = new RegExp("^" + kanji + "$");
    var TEST_NUMERIC = new RegExp("^" + numeric + "$");
    var TEST_ALPHANUMERIC = new RegExp("^[A-Z0-9 $%*+\\-./:]+$");
    exports.testKanji = function testKanji(str) {
      return TEST_KANJI.test(str);
    };
    exports.testNumeric = function testNumeric(str) {
      return TEST_NUMERIC.test(str);
    };
    exports.testAlphanumeric = function testAlphanumeric(str) {
      return TEST_ALPHANUMERIC.test(str);
    };
  }
});

// node_modules/qrcode/lib/core/mode.js
var require_mode = __commonJS({
  "node_modules/qrcode/lib/core/mode.js"(exports) {
    var VersionCheck = require_version_check();
    var Regex = require_regex();
    exports.NUMERIC = {
      id: "Numeric",
      bit: 1 << 0,
      ccBits: [10, 12, 14]
    };
    exports.ALPHANUMERIC = {
      id: "Alphanumeric",
      bit: 1 << 1,
      ccBits: [9, 11, 13]
    };
    exports.BYTE = {
      id: "Byte",
      bit: 1 << 2,
      ccBits: [8, 16, 16]
    };
    exports.KANJI = {
      id: "Kanji",
      bit: 1 << 3,
      ccBits: [8, 10, 12]
    };
    exports.MIXED = {
      bit: -1
    };
    exports.getCharCountIndicator = function getCharCountIndicator(mode, version) {
      if (!mode.ccBits) throw new Error("Invalid mode: " + mode);
      if (!VersionCheck.isValid(version)) {
        throw new Error("Invalid version: " + version);
      }
      if (version >= 1 && version < 10) return mode.ccBits[0];
      else if (version < 27) return mode.ccBits[1];
      return mode.ccBits[2];
    };
    exports.getBestModeForData = function getBestModeForData(dataStr) {
      if (Regex.testNumeric(dataStr)) return exports.NUMERIC;
      else if (Regex.testAlphanumeric(dataStr)) return exports.ALPHANUMERIC;
      else if (Regex.testKanji(dataStr)) return exports.KANJI;
      else return exports.BYTE;
    };
    exports.toString = function toString(mode) {
      if (mode && mode.id) return mode.id;
      throw new Error("Invalid mode");
    };
    exports.isValid = function isValid(mode) {
      return mode && mode.bit && mode.ccBits;
    };
    function fromString(string) {
      if (typeof string !== "string") {
        throw new Error("Param is not a string");
      }
      const lcStr = string.toLowerCase();
      switch (lcStr) {
        case "numeric":
          return exports.NUMERIC;
        case "alphanumeric":
          return exports.ALPHANUMERIC;
        case "kanji":
          return exports.KANJI;
        case "byte":
          return exports.BYTE;
        default:
          throw new Error("Unknown mode: " + string);
      }
    }
    exports.from = function from(value, defaultValue) {
      if (exports.isValid(value)) {
        return value;
      }
      try {
        return fromString(value);
      } catch (e) {
        return defaultValue;
      }
    };
  }
});

// node_modules/qrcode/lib/core/version.js
var require_version = __commonJS({
  "node_modules/qrcode/lib/core/version.js"(exports) {
    var Utils = require_utils();
    var ECCode = require_error_correction_code();
    var ECLevel = require_error_correction_level();
    var Mode = require_mode();
    var VersionCheck = require_version_check();
    var G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
    var G18_BCH = Utils.getBCHDigit(G18);
    function getBestVersionForDataLength(mode, length, errorCorrectionLevel) {
      for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
        if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, mode)) {
          return currentVersion;
        }
      }
      return void 0;
    }
    function getReservedBitsCount(mode, version) {
      return Mode.getCharCountIndicator(mode, version) + 4;
    }
    function getTotalBitsFromDataArray(segments, version) {
      let totalBits = 0;
      segments.forEach(function(data) {
        const reservedBits = getReservedBitsCount(data.mode, version);
        totalBits += reservedBits + data.getBitsLength();
      });
      return totalBits;
    }
    function getBestVersionForMixedData(segments, errorCorrectionLevel) {
      for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
        const length = getTotalBitsFromDataArray(segments, currentVersion);
        if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, Mode.MIXED)) {
          return currentVersion;
        }
      }
      return void 0;
    }
    exports.from = function from(value, defaultValue) {
      if (VersionCheck.isValid(value)) {
        return parseInt(value, 10);
      }
      return defaultValue;
    };
    exports.getCapacity = function getCapacity(version, errorCorrectionLevel, mode) {
      if (!VersionCheck.isValid(version)) {
        throw new Error("Invalid QR Code version");
      }
      if (typeof mode === "undefined") mode = Mode.BYTE;
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      if (mode === Mode.MIXED) return dataTotalCodewordsBits;
      const usableBits = dataTotalCodewordsBits - getReservedBitsCount(mode, version);
      switch (mode) {
        case Mode.NUMERIC:
          return Math.floor(usableBits / 10 * 3);
        case Mode.ALPHANUMERIC:
          return Math.floor(usableBits / 11 * 2);
        case Mode.KANJI:
          return Math.floor(usableBits / 13);
        case Mode.BYTE:
        default:
          return Math.floor(usableBits / 8);
      }
    };
    exports.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
      let seg;
      const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M);
      if (Array.isArray(data)) {
        if (data.length > 1) {
          return getBestVersionForMixedData(data, ecl);
        }
        if (data.length === 0) {
          return 1;
        }
        seg = data[0];
      } else {
        seg = data;
      }
      return getBestVersionForDataLength(seg.mode, seg.getLength(), ecl);
    };
    exports.getEncodedBits = function getEncodedBits(version) {
      if (!VersionCheck.isValid(version) || version < 7) {
        throw new Error("Invalid QR Code version");
      }
      let d = version << 12;
      while (Utils.getBCHDigit(d) - G18_BCH >= 0) {
        d ^= G18 << Utils.getBCHDigit(d) - G18_BCH;
      }
      return version << 12 | d;
    };
  }
});

// node_modules/qrcode/lib/core/format-info.js
var require_format_info = __commonJS({
  "node_modules/qrcode/lib/core/format-info.js"(exports) {
    var Utils = require_utils();
    var G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
    var G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
    var G15_BCH = Utils.getBCHDigit(G15);
    exports.getEncodedBits = function getEncodedBits(errorCorrectionLevel, mask) {
      const data = errorCorrectionLevel.bit << 3 | mask;
      let d = data << 10;
      while (Utils.getBCHDigit(d) - G15_BCH >= 0) {
        d ^= G15 << Utils.getBCHDigit(d) - G15_BCH;
      }
      return (data << 10 | d) ^ G15_MASK;
    };
  }
});

// node_modules/qrcode/lib/core/numeric-data.js
var require_numeric_data = __commonJS({
  "node_modules/qrcode/lib/core/numeric-data.js"(exports, module) {
    var Mode = require_mode();
    function NumericData(data) {
      this.mode = Mode.NUMERIC;
      this.data = data.toString();
    }
    NumericData.getBitsLength = function getBitsLength(length) {
      return 10 * Math.floor(length / 3) + (length % 3 ? length % 3 * 3 + 1 : 0);
    };
    NumericData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    NumericData.prototype.getBitsLength = function getBitsLength() {
      return NumericData.getBitsLength(this.data.length);
    };
    NumericData.prototype.write = function write(bitBuffer) {
      let i, group, value;
      for (i = 0; i + 3 <= this.data.length; i += 3) {
        group = this.data.substr(i, 3);
        value = parseInt(group, 10);
        bitBuffer.put(value, 10);
      }
      const remainingNum = this.data.length - i;
      if (remainingNum > 0) {
        group = this.data.substr(i);
        value = parseInt(group, 10);
        bitBuffer.put(value, remainingNum * 3 + 1);
      }
    };
    module.exports = NumericData;
  }
});

// node_modules/qrcode/lib/core/alphanumeric-data.js
var require_alphanumeric_data = __commonJS({
  "node_modules/qrcode/lib/core/alphanumeric-data.js"(exports, module) {
    var Mode = require_mode();
    var ALPHA_NUM_CHARS = [
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "Q",
      "R",
      "S",
      "T",
      "U",
      "V",
      "W",
      "X",
      "Y",
      "Z",
      " ",
      "$",
      "%",
      "*",
      "+",
      "-",
      ".",
      "/",
      ":"
    ];
    function AlphanumericData(data) {
      this.mode = Mode.ALPHANUMERIC;
      this.data = data;
    }
    AlphanumericData.getBitsLength = function getBitsLength(length) {
      return 11 * Math.floor(length / 2) + 6 * (length % 2);
    };
    AlphanumericData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    AlphanumericData.prototype.getBitsLength = function getBitsLength() {
      return AlphanumericData.getBitsLength(this.data.length);
    };
    AlphanumericData.prototype.write = function write(bitBuffer) {
      let i;
      for (i = 0; i + 2 <= this.data.length; i += 2) {
        let value = ALPHA_NUM_CHARS.indexOf(this.data[i]) * 45;
        value += ALPHA_NUM_CHARS.indexOf(this.data[i + 1]);
        bitBuffer.put(value, 11);
      }
      if (this.data.length % 2) {
        bitBuffer.put(ALPHA_NUM_CHARS.indexOf(this.data[i]), 6);
      }
    };
    module.exports = AlphanumericData;
  }
});

// node_modules/qrcode/lib/core/byte-data.js
var require_byte_data = __commonJS({
  "node_modules/qrcode/lib/core/byte-data.js"(exports, module) {
    var Mode = require_mode();
    function ByteData(data) {
      this.mode = Mode.BYTE;
      if (typeof data === "string") {
        this.data = new TextEncoder().encode(data);
      } else {
        this.data = new Uint8Array(data);
      }
    }
    ByteData.getBitsLength = function getBitsLength(length) {
      return length * 8;
    };
    ByteData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    ByteData.prototype.getBitsLength = function getBitsLength() {
      return ByteData.getBitsLength(this.data.length);
    };
    ByteData.prototype.write = function(bitBuffer) {
      for (let i = 0, l = this.data.length; i < l; i++) {
        bitBuffer.put(this.data[i], 8);
      }
    };
    module.exports = ByteData;
  }
});

// node_modules/qrcode/lib/core/kanji-data.js
var require_kanji_data = __commonJS({
  "node_modules/qrcode/lib/core/kanji-data.js"(exports, module) {
    var Mode = require_mode();
    var Utils = require_utils();
    function KanjiData(data) {
      this.mode = Mode.KANJI;
      this.data = data;
    }
    KanjiData.getBitsLength = function getBitsLength(length) {
      return length * 13;
    };
    KanjiData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    KanjiData.prototype.getBitsLength = function getBitsLength() {
      return KanjiData.getBitsLength(this.data.length);
    };
    KanjiData.prototype.write = function(bitBuffer) {
      let i;
      for (i = 0; i < this.data.length; i++) {
        let value = Utils.toSJIS(this.data[i]);
        if (value >= 33088 && value <= 40956) {
          value -= 33088;
        } else if (value >= 57408 && value <= 60351) {
          value -= 49472;
        } else {
          throw new Error(
            "Invalid SJIS character: " + this.data[i] + "\nMake sure your charset is UTF-8"
          );
        }
        value = (value >>> 8 & 255) * 192 + (value & 255);
        bitBuffer.put(value, 13);
      }
    };
    module.exports = KanjiData;
  }
});

// node_modules/dijkstrajs/dijkstra.js
var require_dijkstra = __commonJS({
  "node_modules/dijkstrajs/dijkstra.js"(exports, module) {
    "use strict";
    var dijkstra = {
      single_source_shortest_paths: function(graph, s, d) {
        var predecessors = {};
        var costs = {};
        costs[s] = 0;
        var open = dijkstra.PriorityQueue.make();
        open.push(s, 0);
        var closest, u, v, cost_of_s_to_u, adjacent_nodes, cost_of_e, cost_of_s_to_u_plus_cost_of_e, cost_of_s_to_v, first_visit;
        while (!open.empty()) {
          closest = open.pop();
          u = closest.value;
          cost_of_s_to_u = closest.cost;
          adjacent_nodes = graph[u] || {};
          for (v in adjacent_nodes) {
            if (adjacent_nodes.hasOwnProperty(v)) {
              cost_of_e = adjacent_nodes[v];
              cost_of_s_to_u_plus_cost_of_e = cost_of_s_to_u + cost_of_e;
              cost_of_s_to_v = costs[v];
              first_visit = typeof costs[v] === "undefined";
              if (first_visit || cost_of_s_to_v > cost_of_s_to_u_plus_cost_of_e) {
                costs[v] = cost_of_s_to_u_plus_cost_of_e;
                open.push(v, cost_of_s_to_u_plus_cost_of_e);
                predecessors[v] = u;
              }
            }
          }
        }
        if (typeof d !== "undefined" && typeof costs[d] === "undefined") {
          var msg = ["Could not find a path from ", s, " to ", d, "."].join("");
          throw new Error(msg);
        }
        return predecessors;
      },
      extract_shortest_path_from_predecessor_list: function(predecessors, d) {
        var nodes = [];
        var u = d;
        var predecessor;
        while (u) {
          nodes.push(u);
          predecessor = predecessors[u];
          u = predecessors[u];
        }
        nodes.reverse();
        return nodes;
      },
      find_path: function(graph, s, d) {
        var predecessors = dijkstra.single_source_shortest_paths(graph, s, d);
        return dijkstra.extract_shortest_path_from_predecessor_list(
          predecessors,
          d
        );
      },
      /**
       * A very naive priority queue implementation.
       */
      PriorityQueue: {
        make: function(opts) {
          var T = dijkstra.PriorityQueue, t = {}, key;
          opts = opts || {};
          for (key in T) {
            if (T.hasOwnProperty(key)) {
              t[key] = T[key];
            }
          }
          t.queue = [];
          t.sorter = opts.sorter || T.default_sorter;
          return t;
        },
        default_sorter: function(a, b) {
          return a.cost - b.cost;
        },
        /**
         * Add a new item to the queue and ensure the highest priority element
         * is at the front of the queue.
         */
        push: function(value, cost) {
          var item = { value, cost };
          this.queue.push(item);
          this.queue.sort(this.sorter);
        },
        /**
         * Return the highest priority element in the queue.
         */
        pop: function() {
          return this.queue.shift();
        },
        empty: function() {
          return this.queue.length === 0;
        }
      }
    };
    if (typeof module !== "undefined") {
      module.exports = dijkstra;
    }
  }
});

// node_modules/qrcode/lib/core/segments.js
var require_segments = __commonJS({
  "node_modules/qrcode/lib/core/segments.js"(exports) {
    var Mode = require_mode();
    var NumericData = require_numeric_data();
    var AlphanumericData = require_alphanumeric_data();
    var ByteData = require_byte_data();
    var KanjiData = require_kanji_data();
    var Regex = require_regex();
    var Utils = require_utils();
    var dijkstra = require_dijkstra();
    function getStringByteLength(str) {
      return unescape(encodeURIComponent(str)).length;
    }
    function getSegments(regex, mode, str) {
      const segments = [];
      let result;
      while ((result = regex.exec(str)) !== null) {
        segments.push({
          data: result[0],
          index: result.index,
          mode,
          length: result[0].length
        });
      }
      return segments;
    }
    function getSegmentsFromString(dataStr) {
      const numSegs = getSegments(Regex.NUMERIC, Mode.NUMERIC, dataStr);
      const alphaNumSegs = getSegments(Regex.ALPHANUMERIC, Mode.ALPHANUMERIC, dataStr);
      let byteSegs;
      let kanjiSegs;
      if (Utils.isKanjiModeEnabled()) {
        byteSegs = getSegments(Regex.BYTE, Mode.BYTE, dataStr);
        kanjiSegs = getSegments(Regex.KANJI, Mode.KANJI, dataStr);
      } else {
        byteSegs = getSegments(Regex.BYTE_KANJI, Mode.BYTE, dataStr);
        kanjiSegs = [];
      }
      const segs = numSegs.concat(alphaNumSegs, byteSegs, kanjiSegs);
      return segs.sort(function(s1, s2) {
        return s1.index - s2.index;
      }).map(function(obj) {
        return {
          data: obj.data,
          mode: obj.mode,
          length: obj.length
        };
      });
    }
    function getSegmentBitsLength(length, mode) {
      switch (mode) {
        case Mode.NUMERIC:
          return NumericData.getBitsLength(length);
        case Mode.ALPHANUMERIC:
          return AlphanumericData.getBitsLength(length);
        case Mode.KANJI:
          return KanjiData.getBitsLength(length);
        case Mode.BYTE:
          return ByteData.getBitsLength(length);
      }
    }
    function mergeSegments(segs) {
      return segs.reduce(function(acc, curr) {
        const prevSeg = acc.length - 1 >= 0 ? acc[acc.length - 1] : null;
        if (prevSeg && prevSeg.mode === curr.mode) {
          acc[acc.length - 1].data += curr.data;
          return acc;
        }
        acc.push(curr);
        return acc;
      }, []);
    }
    function buildNodes(segs) {
      const nodes = [];
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        switch (seg.mode) {
          case Mode.NUMERIC:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.ALPHANUMERIC, length: seg.length },
              { data: seg.data, mode: Mode.BYTE, length: seg.length }
            ]);
            break;
          case Mode.ALPHANUMERIC:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.BYTE, length: seg.length }
            ]);
            break;
          case Mode.KANJI:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
            ]);
            break;
          case Mode.BYTE:
            nodes.push([
              { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
            ]);
        }
      }
      return nodes;
    }
    function buildGraph(nodes, version) {
      const table = {};
      const graph = { start: {} };
      let prevNodeIds = ["start"];
      for (let i = 0; i < nodes.length; i++) {
        const nodeGroup = nodes[i];
        const currentNodeIds = [];
        for (let j = 0; j < nodeGroup.length; j++) {
          const node = nodeGroup[j];
          const key = "" + i + j;
          currentNodeIds.push(key);
          table[key] = { node, lastCount: 0 };
          graph[key] = {};
          for (let n = 0; n < prevNodeIds.length; n++) {
            const prevNodeId = prevNodeIds[n];
            if (table[prevNodeId] && table[prevNodeId].node.mode === node.mode) {
              graph[prevNodeId][key] = getSegmentBitsLength(table[prevNodeId].lastCount + node.length, node.mode) - getSegmentBitsLength(table[prevNodeId].lastCount, node.mode);
              table[prevNodeId].lastCount += node.length;
            } else {
              if (table[prevNodeId]) table[prevNodeId].lastCount = node.length;
              graph[prevNodeId][key] = getSegmentBitsLength(node.length, node.mode) + 4 + Mode.getCharCountIndicator(node.mode, version);
            }
          }
        }
        prevNodeIds = currentNodeIds;
      }
      for (let n = 0; n < prevNodeIds.length; n++) {
        graph[prevNodeIds[n]].end = 0;
      }
      return { map: graph, table };
    }
    function buildSingleSegment(data, modesHint) {
      let mode;
      const bestMode = Mode.getBestModeForData(data);
      mode = Mode.from(modesHint, bestMode);
      if (mode !== Mode.BYTE && mode.bit < bestMode.bit) {
        throw new Error('"' + data + '" cannot be encoded with mode ' + Mode.toString(mode) + ".\n Suggested mode is: " + Mode.toString(bestMode));
      }
      if (mode === Mode.KANJI && !Utils.isKanjiModeEnabled()) {
        mode = Mode.BYTE;
      }
      switch (mode) {
        case Mode.NUMERIC:
          return new NumericData(data);
        case Mode.ALPHANUMERIC:
          return new AlphanumericData(data);
        case Mode.KANJI:
          return new KanjiData(data);
        case Mode.BYTE:
          return new ByteData(data);
      }
    }
    exports.fromArray = function fromArray(array) {
      return array.reduce(function(acc, seg) {
        if (typeof seg === "string") {
          acc.push(buildSingleSegment(seg, null));
        } else if (seg.data) {
          acc.push(buildSingleSegment(seg.data, seg.mode));
        }
        return acc;
      }, []);
    };
    exports.fromString = function fromString(data, version) {
      const segs = getSegmentsFromString(data, Utils.isKanjiModeEnabled());
      const nodes = buildNodes(segs);
      const graph = buildGraph(nodes, version);
      const path = dijkstra.find_path(graph.map, "start", "end");
      const optimizedSegs = [];
      for (let i = 1; i < path.length - 1; i++) {
        optimizedSegs.push(graph.table[path[i]].node);
      }
      return exports.fromArray(mergeSegments(optimizedSegs));
    };
    exports.rawSplit = function rawSplit(data) {
      return exports.fromArray(
        getSegmentsFromString(data, Utils.isKanjiModeEnabled())
      );
    };
  }
});

// node_modules/qrcode/lib/core/qrcode.js
var require_qrcode = __commonJS({
  "node_modules/qrcode/lib/core/qrcode.js"(exports) {
    var Utils = require_utils();
    var ECLevel = require_error_correction_level();
    var BitBuffer = require_bit_buffer();
    var BitMatrix = require_bit_matrix();
    var AlignmentPattern = require_alignment_pattern();
    var FinderPattern = require_finder_pattern();
    var MaskPattern = require_mask_pattern();
    var ECCode = require_error_correction_code();
    var ReedSolomonEncoder = require_reed_solomon_encoder();
    var Version = require_version();
    var FormatInfo = require_format_info();
    var Mode = require_mode();
    var Segments = require_segments();
    function setupFinderPattern(matrix, version) {
      const size = matrix.size;
      const pos = FinderPattern.getPositions(version);
      for (let i = 0; i < pos.length; i++) {
        const row = pos[i][0];
        const col = pos[i][1];
        for (let r = -1; r <= 7; r++) {
          if (row + r <= -1 || size <= row + r) continue;
          for (let c2 = -1; c2 <= 7; c2++) {
            if (col + c2 <= -1 || size <= col + c2) continue;
            if (r >= 0 && r <= 6 && (c2 === 0 || c2 === 6) || c2 >= 0 && c2 <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c2 >= 2 && c2 <= 4) {
              matrix.set(row + r, col + c2, true, true);
            } else {
              matrix.set(row + r, col + c2, false, true);
            }
          }
        }
      }
    }
    function setupTimingPattern(matrix) {
      const size = matrix.size;
      for (let r = 8; r < size - 8; r++) {
        const value = r % 2 === 0;
        matrix.set(r, 6, value, true);
        matrix.set(6, r, value, true);
      }
    }
    function setupAlignmentPattern(matrix, version) {
      const pos = AlignmentPattern.getPositions(version);
      for (let i = 0; i < pos.length; i++) {
        const row = pos[i][0];
        const col = pos[i][1];
        for (let r = -2; r <= 2; r++) {
          for (let c2 = -2; c2 <= 2; c2++) {
            if (r === -2 || r === 2 || c2 === -2 || c2 === 2 || r === 0 && c2 === 0) {
              matrix.set(row + r, col + c2, true, true);
            } else {
              matrix.set(row + r, col + c2, false, true);
            }
          }
        }
      }
    }
    function setupVersionInfo(matrix, version) {
      const size = matrix.size;
      const bits = Version.getEncodedBits(version);
      let row, col, mod;
      for (let i = 0; i < 18; i++) {
        row = Math.floor(i / 3);
        col = i % 3 + size - 8 - 3;
        mod = (bits >> i & 1) === 1;
        matrix.set(row, col, mod, true);
        matrix.set(col, row, mod, true);
      }
    }
    function setupFormatInfo(matrix, errorCorrectionLevel, maskPattern) {
      const size = matrix.size;
      const bits = FormatInfo.getEncodedBits(errorCorrectionLevel, maskPattern);
      let i, mod;
      for (i = 0; i < 15; i++) {
        mod = (bits >> i & 1) === 1;
        if (i < 6) {
          matrix.set(i, 8, mod, true);
        } else if (i < 8) {
          matrix.set(i + 1, 8, mod, true);
        } else {
          matrix.set(size - 15 + i, 8, mod, true);
        }
        if (i < 8) {
          matrix.set(8, size - i - 1, mod, true);
        } else if (i < 9) {
          matrix.set(8, 15 - i - 1 + 1, mod, true);
        } else {
          matrix.set(8, 15 - i - 1, mod, true);
        }
      }
      matrix.set(size - 8, 8, 1, true);
    }
    function setupData(matrix, data) {
      const size = matrix.size;
      let inc = -1;
      let row = size - 1;
      let bitIndex = 7;
      let byteIndex = 0;
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        while (true) {
          for (let c2 = 0; c2 < 2; c2++) {
            if (!matrix.isReserved(row, col - c2)) {
              let dark = false;
              if (byteIndex < data.length) {
                dark = (data[byteIndex] >>> bitIndex & 1) === 1;
              }
              matrix.set(row, col - c2, dark);
              bitIndex--;
              if (bitIndex === -1) {
                byteIndex++;
                bitIndex = 7;
              }
            }
          }
          row += inc;
          if (row < 0 || size <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    }
    function createData(version, errorCorrectionLevel, segments) {
      const buffer = new BitBuffer();
      segments.forEach(function(data) {
        buffer.put(data.mode.bit, 4);
        buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
        data.write(buffer);
      });
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) {
        buffer.put(0, 4);
      }
      while (buffer.getLengthInBits() % 8 !== 0) {
        buffer.putBit(0);
      }
      const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
      for (let i = 0; i < remainingByte; i++) {
        buffer.put(i % 2 ? 17 : 236, 8);
      }
      return createCodewords(buffer, version, errorCorrectionLevel);
    }
    function createCodewords(bitBuffer, version, errorCorrectionLevel) {
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewords = totalCodewords - ecTotalCodewords;
      const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel);
      const blocksInGroup2 = totalCodewords % ecTotalBlocks;
      const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
      const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
      const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
      const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
      const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
      const rs = new ReedSolomonEncoder(ecCount);
      let offset = 0;
      const dcData = new Array(ecTotalBlocks);
      const ecData = new Array(ecTotalBlocks);
      let maxDataSize = 0;
      const buffer = new Uint8Array(bitBuffer.buffer);
      for (let b = 0; b < ecTotalBlocks; b++) {
        const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
        dcData[b] = buffer.slice(offset, offset + dataSize);
        ecData[b] = rs.encode(dcData[b]);
        offset += dataSize;
        maxDataSize = Math.max(maxDataSize, dataSize);
      }
      const data = new Uint8Array(totalCodewords);
      let index = 0;
      let i, r;
      for (i = 0; i < maxDataSize; i++) {
        for (r = 0; r < ecTotalBlocks; r++) {
          if (i < dcData[r].length) {
            data[index++] = dcData[r][i];
          }
        }
      }
      for (i = 0; i < ecCount; i++) {
        for (r = 0; r < ecTotalBlocks; r++) {
          data[index++] = ecData[r][i];
        }
      }
      return data;
    }
    function createSymbol(data, version, errorCorrectionLevel, maskPattern) {
      let segments;
      if (Array.isArray(data)) {
        segments = Segments.fromArray(data);
      } else if (typeof data === "string") {
        let estimatedVersion = version;
        if (!estimatedVersion) {
          const rawSegments = Segments.rawSplit(data);
          estimatedVersion = Version.getBestVersionForData(rawSegments, errorCorrectionLevel);
        }
        segments = Segments.fromString(data, estimatedVersion || 40);
      } else {
        throw new Error("Invalid data");
      }
      const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel);
      if (!bestVersion) {
        throw new Error("The amount of data is too big to be stored in a QR Code");
      }
      if (!version) {
        version = bestVersion;
      } else if (version < bestVersion) {
        throw new Error(
          "\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: " + bestVersion + ".\n"
        );
      }
      const dataBits = createData(version, errorCorrectionLevel, segments);
      const moduleCount = Utils.getSymbolSize(version);
      const modules = new BitMatrix(moduleCount);
      setupFinderPattern(modules, version);
      setupTimingPattern(modules);
      setupAlignmentPattern(modules, version);
      setupFormatInfo(modules, errorCorrectionLevel, 0);
      if (version >= 7) {
        setupVersionInfo(modules, version);
      }
      setupData(modules, dataBits);
      if (isNaN(maskPattern)) {
        maskPattern = MaskPattern.getBestMask(
          modules,
          setupFormatInfo.bind(null, modules, errorCorrectionLevel)
        );
      }
      MaskPattern.applyMask(maskPattern, modules);
      setupFormatInfo(modules, errorCorrectionLevel, maskPattern);
      return {
        modules,
        version,
        errorCorrectionLevel,
        maskPattern,
        segments
      };
    }
    exports.create = function create(data, options) {
      if (typeof data === "undefined" || data === "") {
        throw new Error("No input text");
      }
      let errorCorrectionLevel = ECLevel.M;
      let version;
      let mask;
      if (typeof options !== "undefined") {
        errorCorrectionLevel = ECLevel.from(options.errorCorrectionLevel, ECLevel.M);
        version = Version.from(options.version);
        mask = MaskPattern.from(options.maskPattern);
        if (options.toSJISFunc) {
          Utils.setToSJISFunction(options.toSJISFunc);
        }
      }
      return createSymbol(data, version, errorCorrectionLevel, mask);
    };
  }
});

// node_modules/qrcode/lib/renderer/utils.js
var require_utils2 = __commonJS({
  "node_modules/qrcode/lib/renderer/utils.js"(exports) {
    function hex2rgba(hex) {
      if (typeof hex === "number") {
        hex = hex.toString();
      }
      if (typeof hex !== "string") {
        throw new Error("Color should be defined as hex string");
      }
      let hexCode = hex.slice().replace("#", "").split("");
      if (hexCode.length < 3 || hexCode.length === 5 || hexCode.length > 8) {
        throw new Error("Invalid hex color: " + hex);
      }
      if (hexCode.length === 3 || hexCode.length === 4) {
        hexCode = Array.prototype.concat.apply([], hexCode.map(function(c2) {
          return [c2, c2];
        }));
      }
      if (hexCode.length === 6) hexCode.push("F", "F");
      const hexValue = parseInt(hexCode.join(""), 16);
      return {
        r: hexValue >> 24 & 255,
        g: hexValue >> 16 & 255,
        b: hexValue >> 8 & 255,
        a: hexValue & 255,
        hex: "#" + hexCode.slice(0, 6).join("")
      };
    }
    exports.getOptions = function getOptions(options) {
      if (!options) options = {};
      if (!options.color) options.color = {};
      const margin = typeof options.margin === "undefined" || options.margin === null || options.margin < 0 ? 4 : options.margin;
      const width = options.width && options.width >= 21 ? options.width : void 0;
      const scale = options.scale || 4;
      return {
        width,
        scale: width ? 4 : scale,
        margin,
        color: {
          dark: hex2rgba(options.color.dark || "#000000ff"),
          light: hex2rgba(options.color.light || "#ffffffff")
        },
        type: options.type,
        rendererOpts: options.rendererOpts || {}
      };
    };
    exports.getScale = function getScale(qrSize, opts) {
      return opts.width && opts.width >= qrSize + opts.margin * 2 ? opts.width / (qrSize + opts.margin * 2) : opts.scale;
    };
    exports.getImageWidth = function getImageWidth(qrSize, opts) {
      const scale = exports.getScale(qrSize, opts);
      return Math.floor((qrSize + opts.margin * 2) * scale);
    };
    exports.qrToImageData = function qrToImageData(imgData, qr, opts) {
      const size = qr.modules.size;
      const data = qr.modules.data;
      const scale = exports.getScale(size, opts);
      const symbolSize = Math.floor((size + opts.margin * 2) * scale);
      const scaledMargin = opts.margin * scale;
      const palette = [opts.color.light, opts.color.dark];
      for (let i = 0; i < symbolSize; i++) {
        for (let j = 0; j < symbolSize; j++) {
          let posDst = (i * symbolSize + j) * 4;
          let pxColor = opts.color.light;
          if (i >= scaledMargin && j >= scaledMargin && i < symbolSize - scaledMargin && j < symbolSize - scaledMargin) {
            const iSrc = Math.floor((i - scaledMargin) / scale);
            const jSrc = Math.floor((j - scaledMargin) / scale);
            pxColor = palette[data[iSrc * size + jSrc] ? 1 : 0];
          }
          imgData[posDst++] = pxColor.r;
          imgData[posDst++] = pxColor.g;
          imgData[posDst++] = pxColor.b;
          imgData[posDst] = pxColor.a;
        }
      }
    };
  }
});

// node_modules/qrcode/lib/renderer/canvas.js
var require_canvas = __commonJS({
  "node_modules/qrcode/lib/renderer/canvas.js"(exports) {
    var Utils = require_utils2();
    function clearCanvas(ctx, canvas, size) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!canvas.style) canvas.style = {};
      canvas.height = size;
      canvas.width = size;
      canvas.style.height = size + "px";
      canvas.style.width = size + "px";
    }
    function getCanvasElement() {
      try {
        return document.createElement("canvas");
      } catch (e) {
        throw new Error("You need to specify a canvas element");
      }
    }
    exports.render = function render(qrData, canvas, options) {
      let opts = options;
      let canvasEl = canvas;
      if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
        opts = canvas;
        canvas = void 0;
      }
      if (!canvas) {
        canvasEl = getCanvasElement();
      }
      opts = Utils.getOptions(opts);
      const size = Utils.getImageWidth(qrData.modules.size, opts);
      const ctx = canvasEl.getContext("2d");
      const image = ctx.createImageData(size, size);
      Utils.qrToImageData(image.data, qrData, opts);
      clearCanvas(ctx, canvasEl, size);
      ctx.putImageData(image, 0, 0);
      return canvasEl;
    };
    exports.renderToDataURL = function renderToDataURL(qrData, canvas, options) {
      let opts = options;
      if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
        opts = canvas;
        canvas = void 0;
      }
      if (!opts) opts = {};
      const canvasEl = exports.render(qrData, canvas, opts);
      const type = opts.type || "image/png";
      const rendererOpts = opts.rendererOpts || {};
      return canvasEl.toDataURL(type, rendererOpts.quality);
    };
  }
});

// node_modules/qrcode/lib/renderer/svg-tag.js
var require_svg_tag = __commonJS({
  "node_modules/qrcode/lib/renderer/svg-tag.js"(exports) {
    var Utils = require_utils2();
    function getColorAttrib(color, attrib) {
      const alpha = color.a / 255;
      const str = attrib + '="' + color.hex + '"';
      return alpha < 1 ? str + " " + attrib + '-opacity="' + alpha.toFixed(2).slice(1) + '"' : str;
    }
    function svgCmd(cmd, x, y) {
      let str = cmd + x;
      if (typeof y !== "undefined") str += " " + y;
      return str;
    }
    function qrToPath(data, size, margin) {
      let path = "";
      let moveBy = 0;
      let newRow = false;
      let lineLength = 0;
      for (let i = 0; i < data.length; i++) {
        const col = Math.floor(i % size);
        const row = Math.floor(i / size);
        if (!col && !newRow) newRow = true;
        if (data[i]) {
          lineLength++;
          if (!(i > 0 && col > 0 && data[i - 1])) {
            path += newRow ? svgCmd("M", col + margin, 0.5 + row + margin) : svgCmd("m", moveBy, 0);
            moveBy = 0;
            newRow = false;
          }
          if (!(col + 1 < size && data[i + 1])) {
            path += svgCmd("h", lineLength);
            lineLength = 0;
          }
        } else {
          moveBy++;
        }
      }
      return path;
    }
    exports.render = function render(qrData, options, cb) {
      const opts = Utils.getOptions(options);
      const size = qrData.modules.size;
      const data = qrData.modules.data;
      const qrcodesize = size + opts.margin * 2;
      const bg = !opts.color.light.a ? "" : "<path " + getColorAttrib(opts.color.light, "fill") + ' d="M0 0h' + qrcodesize + "v" + qrcodesize + 'H0z"/>';
      const path = "<path " + getColorAttrib(opts.color.dark, "stroke") + ' d="' + qrToPath(data, size, opts.margin) + '"/>';
      const viewBox = 'viewBox="0 0 ' + qrcodesize + " " + qrcodesize + '"';
      const width = !opts.width ? "" : 'width="' + opts.width + '" height="' + opts.width + '" ';
      const svgTag = '<svg xmlns="http://www.w3.org/2000/svg" ' + width + viewBox + ' shape-rendering="crispEdges">' + bg + path + "</svg>\n";
      if (typeof cb === "function") {
        cb(null, svgTag);
      }
      return svgTag;
    };
  }
});

// node_modules/qrcode/lib/browser.js
var require_browser = __commonJS({
  "node_modules/qrcode/lib/browser.js"(exports) {
    var canPromise = require_can_promise();
    var QRCode = require_qrcode();
    var CanvasRenderer = require_canvas();
    var SvgRenderer = require_svg_tag();
    function renderCanvas(renderFunc, canvas, text, opts, cb) {
      const args = [].slice.call(arguments, 1);
      const argsNum = args.length;
      const isLastArgCb = typeof args[argsNum - 1] === "function";
      if (!isLastArgCb && !canPromise()) {
        throw new Error("Callback required as last argument");
      }
      if (isLastArgCb) {
        if (argsNum < 2) {
          throw new Error("Too few arguments provided");
        }
        if (argsNum === 2) {
          cb = text;
          text = canvas;
          canvas = opts = void 0;
        } else if (argsNum === 3) {
          if (canvas.getContext && typeof cb === "undefined") {
            cb = opts;
            opts = void 0;
          } else {
            cb = opts;
            opts = text;
            text = canvas;
            canvas = void 0;
          }
        }
      } else {
        if (argsNum < 1) {
          throw new Error("Too few arguments provided");
        }
        if (argsNum === 1) {
          text = canvas;
          canvas = opts = void 0;
        } else if (argsNum === 2 && !canvas.getContext) {
          opts = text;
          text = canvas;
          canvas = void 0;
        }
        return new Promise(function(resolve, reject) {
          try {
            const data = QRCode.create(text, opts);
            resolve(renderFunc(data, canvas, opts));
          } catch (e) {
            reject(e);
          }
        });
      }
      try {
        const data = QRCode.create(text, opts);
        cb(null, renderFunc(data, canvas, opts));
      } catch (e) {
        cb(e);
      }
    }
    exports.create = QRCode.create;
    exports.toCanvas = renderCanvas.bind(null, CanvasRenderer.render);
    exports.toDataURL = renderCanvas.bind(null, CanvasRenderer.renderToDataURL);
    exports.toString = renderCanvas.bind(null, function(data, _, opts) {
      return SvgRenderer.render(data, opts);
    });
  }
});

// server/i18n.ts
var I18N = {
  en: {
    "services.exposeSection": "Public access (auth gateway)",
    "services.exposeLoading": "Loading config\u2026",
    "services.exposeMode": "Mode",
    "services.exposeModeTunnel": "tunnel (public URL)",
    "services.exposeModeProxy": "proxy (local vhost, no tunnel)",
    "services.exposeModeBoth": "both (local + tunnel)",
    "services.exposeSite": "Site (auth realm)",
    "services.exposeBasePath": "Base path (service)",
    "services.exposeSiteDefault": "default",
    "services.allowToolDownload": "Allow online tool downloads",
    "services.allowToolDownloadHint": "When disabled, only tools already installed on this machine are used; missing tools are not downloaded automatically.",
    "services.toolsMissing": "missing",
    "services.exposeProtocol": "Protocol",
    "services.selectProvider": "Select provider\u2026",
    "services.exposeProvider": "Auth provider",
    "services.exposeProviderNone": "none (no auth)",
    "services.fixedParamHint": "Fixed predefined parameter (read-only)",
    "services.provider.oauth2-github": "GitHub OAuth",
    "services.provider.oauth2-google": "Google OAuth",
    "services.provider.oauth2-gitlab": "GitLab OAuth",
    "services.provider.oauth2-microsoft": "Microsoft Entra ID",
    "services.provider.oauth2-keycloak": "Keycloak",
    "services.provider.oauth2-okta": "Okta",
    "services.provider.oauth2-generic": "Generic OIDC",
    "services.noAuthWarnHint": "No auth protection: anyone with the URL can access it (data-leak risk)",
    "services.exposeLogs": "Logs",
    "services.exposeLogsHide": "Hide logs",
    "services.exposeStop": "Stop",
    "services.exposeStopHint": "Stop this channel only (other exposes of this port stay up)",
    "services.confirmNoAuthTitle": "No auth protection (data-leak risk)",
    "services.confirmNoAuthBodyPort": "This method has no gateway auth \u2014 port {port} will be publicly reachable by anyone with the URL. Data may be exposed. Continue?",
    "services.confirmNoAuthBodySelf": "This method has no gateway auth \u2014 the pi-web admin UI will be publicly reachable by anyone with the URL. Data may be exposed. Continue?",
    "services.exposeConfirm": "Expose anyway",
    "services.exposeAbort": "Cancel",
    "services.userCheckUnavailable": "Cannot verify auth users \u2014 refresh and retry",
    "services.confirmNoUsersTitle": "No users for this auth",
    "services.confirmNoUsersBody": "No users under provider \xAB{provider}\xBB / site \xAB{site}\xBB. Add one on the Users tab first (select the same provider and site), then expose again.",
    "services.confirmNoUsersGo": "Manage users",
    "services.confirmUsersTitle": "Confirm you can sign in",
    "services.confirmUsersBody": "The following accounts can sign in through this gateway (provider \xAB{provider}\xBB / site \xAB{site}\xBB). Make sure you hold the password of at least one of them \u2014 you'll need it to access the exposed service.",
    "services.confirmUsersConfirm": "I can sign in \u2014 expose",
    "services.exposeAuth": "Require sign-in",
    "services.exposeTunnelTool": "Tunnel",
    "services.tunnelParams": "Tunnel params",
    "services.recommended": "Recommended",
    "services.authParams": "Auth params",
    "services.exposeGo": "Expose now",
    "services.preset": "Preset",
    "services.presetHint": "Pick a saved preset to fill the whole form; the last-used options are auto-loaded when this opens",
    "services.presetLastUsed": "Last used",
    "services.presetLastUsedNone": "Last used (none yet)",
    "services.presetSaveAs": "Save as preset",
    "services.presetActionsEnroll": "Enroll port (vhost reachable)",
    "services.presetActionsEnrollHint": "On apply: auto-enroll this port as an open vhost (with current Base Path)",
    "services.presetActionsExpose": "Expose immediately",
    "services.presetActionsExposeHint": "On apply: auto-expose using this scheme (auth confirm flow still applies)",
    "services.presetActionsInject": "Enable injectors",
    "services.presetActionsInjectHint": "On apply: auto-enable currently checked injector sources",
    "services.presetActionsInjectNone": "none enabled",
    "services.presetSaveAsHint": "Save the current form choices as a named preset (secrets are encrypted on disk)",
    "services.presetSave": "Save",
    "services.presetNamePlaceholder": "Preset name",
    "services.presetDelete": "Delete",
    "services.presetDeleteHint": "Delete this preset (the form keeps its values)",
    "services.presetLoadFailed": "Failed to load preset",
    "services.exposeResult": "Live at",
    "services.injectJs": "Inject JS",
    "services.injectJsEnable": "Enable injection",
    "services.injectJsOn": "Injection on",
    "services.injectJsEnableHint": "When enabled, HTML served through this port's access channels (service vhost / tunnel) gets aiti-launcher.js injected automatically \u2014 the debugger appears in the page",
    "services.injectJsDisableHint": "Turn off debugger injection",
    "services.injectJsBasePath": "Base Path",
    "services.injectJsBasePathHint": "Prefix the service is actually served under (e.g. dev for vite base=/dev/): the vhost proxy strips the deploy prefix then re-attaches it. Empty = root",
    "services.injectJsBasePathPlaceholder": "e.g. dev (empty = /)",
    "services.injectJsModeProxy": "proxy mode (service vhost): active",
    "services.injectJsModeTunnel": "tunnel mode: injection via nginx gateway (static snippet, main-page navigations)",
    "services.injectJsUnavailable": "aiti-devtools extension not loaded \u2014 injection management unavailable",
    "services.injectJsSelfHint": "When enabled, pi-web pages served via vhost/tunnel get the debugger injected (authenticated entries only; direct loopback access is not injected)",
    "services.enrolledExt": "Enrolled external ports",
    "services.enrolledExtHint": "Ports not in pi-web's process tree but enrolled as open vhosts via aiti injection (e.g. systemd/manual dev servers) \u2014 invisible to process scanning, yet actually exposed through the vhost proxy. Unenroll closes both the vhost proxy and injection (the service process itself is untouched)",
    "services.enrolledExtNotTree": "external process",
    "services.enrolledBasePathHint": "Service basePath: the vhost proxy strips the deploy prefix then re-attaches this prefix",
    "services.enrolledUnenroll": "Unenroll",
    "services.enrolledUnenrollHint": "Remove from injection enrollment: closes the vhost proxy (<port>.domain) and HTML injection together; the service process itself is untouched",
    "services.exposeDetail": "Details",
    "services.exposeDetailHint": "Click a link to open it in a new tab; Stop only stops this channel",
    "services.exposeStartedAt": "Started",
    "services.exposeParams": "Params",
    "services.exposeLogFiles": "\u65E5\u5FD7\u6587\u4EF6",
    "services.exposeLogFilesLoading": "Loading\u2026",
    "services.exposeNoLogs": "No log files",
    "services.openLogin": "Open login page",
    "services.authUsers": "Auth & users",
    "services.usersPickCombo": "Users are maintained per site + auth combo. Click a row to manage that combination's users.",
    "services.usersSite": "Site",
    "services.usersAuth": "Auth",
    "services.usersCount": "Users",
    "services.usersTotpCount": "TOTP users",
    "services.usersEditing": "Editing",
    "services.noUserCombos": "No combinations available",
    "services.usersBack": "Back to summary",
    "services.sitesManage": "Sites (auth realms)",
    "services.sitesManageHint": "Each site is an independent auth realm (own provider and user db). Pick one when exposing; manage its users in the table below. Protected sites are built-in dependencies and cannot be removed.",
    "services.sitesProtected": "protected",
    "services.sitesProtectedHint": "Built-in protected site \u2014 the default realm / the self page's auth realm depends on it, cannot be removed",
    "services.sitesRemove": "Remove",
    "services.sitesRemoveHint": "Remove this site (its user db and auth config go with it)",
    "services.sitesRemoveConfirm": 'Remove site "{name}"? Its user db and auth config are removed with it. Active exposures keep running until stopped.',
    "services.sitesRemoveConfirmGo": "Confirm remove",
    "services.sitesAdd": "Add site",
    "services.sitesNamePlaceholder": "new site name (e.g. team-a)",
    "services.sitesProviderAuto": "auto (platform default)",
    "services.userList": "Users",
    "services.addUser": "Add user",
    "services.userName": "Username",
    "services.userPassword": "Password",
    "services.userDisplayName": "Display name",
    "services.userRemove": "Remove",
    "services.userSetPassword": "Set password",
    "services.newPassword": "New password",
    "services.update": "Update",
    "services.totpEnroll": "Enable 2FA (TOTP)",
    "services.totpEnrollConfirm": "Enable",
    "services.totpLabelHint": "2FA label (shown in your authenticator \u2014 editable)",
    "services.totpLabelPlaceholder": "user1-portal-site@host",
    "services.totpDisable": "Disable 2FA (TOTP)",
    "services.totpEnrolled": "2FA (TOTP) on",
    "services.totpOff": "2FA (TOTP) off",
    "services.totpSecret": "Scan with your authenticator app",
    "services.totpManual": "Or enter the secret manually",
    "services.totpActivateHint": "Enter the 6-digit code from your authenticator to activate \u2014 2FA is NOT enforced until verified.",
    "services.totpCode": "6-digit code",
    "services.bioPortalNotRunning": "Enrollment ticket issued, but the portal is not running \u2014 start an expose with this auth provider first, then reopen the capture page",
    "services.bioFacePreparing": "Preparing face enrollment\u2026",
    "services.bioFaceCaptureTitle": "Face enrollment",
    "services.bioFaceCaptureHint": "Look at the camera and open your mouth once to capture each frame (3 frames). The template becomes active after your first successful face login.",
    "services.bioFaceCam": "Camera",
    "services.bioFaceCamAuto": "Auto",
    "services.bioFaceCamError": "Camera unavailable: ",
    "services.bioFaceProgress": "Open mouth {n}/3",
    "services.bioFaceSaving": "Saving template\u2026",
    "services.bioFacePending": "Face pending",
    "services.bioFacePendingHint": "Template saved \u2014 becomes active after your first successful face login",
    "services.bioVoicePending": "Voice pending",
    "services.bioVoicePendingHint": "Template saved \u2014 becomes active after your first successful voice login",
    "services.bioFaceVerify": "Verify now",
    "services.bioFaceRerecord": "Re-record",
    "services.bioFaceRerecordFace": "Re-record face",
    "services.bioFaceRerecordHint": "Capture a new face template (replaces the current one)",
    "services.bioFaceRecorded": "Recorded \u2014 pending verification",
    "services.bioFaceVerified": "Verified",
    "services.bioFaceActiveHint": "Face template is active \u2014 usable at login",
    "services.bioFaceVerifyProgress": "Open mouth {n}/1",
    "services.on": "ON",
    "services.off": "OFF",
    "services.loginInfoButton": "Login info button (username + logout)",
    "services.loginInfoButtonHint": "Inject a floating button on protected pages: shows the logged-in username and a logout button; draggable to screen edges",
    "services.save": "Save",
    "services.cancel": "Cancel",
    "services.displayNameEditHint": "Click to edit the display name (nickname)",
    "services.bioFaceEnroll": "Enable Face 2FA",
    "services.bioFaceHint": "Opens the face capture page (in-browser camera; template stored after first verification)",
    "services.bioFaceOff": "Disable Face",
    "services.bioFaceOffHint": "Remove the stored face template",
    "services.bioFaceOn": "Face on",
    "services.bioVoiceEnroll": "Enable Voice 2FA",
    "services.bioVoiceHint": "Opens the voice capture page (3 spoken digit challenges)",
    "services.bioVoiceOff": "Disable Voice",
    "services.bioVoiceOffHint": "Remove the stored voice template",
    "services.bioVoiceOn": "Voice on",
    "services.bioFaceEnroll": "\u5F00\u542F\u4EBA\u8138 2FA",
    "services.bioFaceHint": "\u6253\u5F00\u4EBA\u8138\u91C7\u96C6\u9875\uFF08\u6D4F\u89C8\u5668\u6444\u50CF\u5934\uFF1B\u9996\u6B21\u9A8C\u8BC1\u901A\u8FC7\u540E\u6A21\u677F\u8F6C\u6B63\uFF09",
    "services.bioFaceOff": "\u5173\u95ED\u4EBA\u8138",
    "services.bioFaceOffHint": "\u5220\u9664\u5DF2\u5B58\u7684\u4EBA\u8138\u6A21\u677F",
    "services.bioFaceOn": "\u4EBA\u8138\u5DF2\u5F00",
    "services.bioVoiceEnroll": "\u5F00\u542F\u8BED\u97F3 2FA",
    "services.bioVoiceHint": "\u6253\u5F00\u8BED\u97F3\u91C7\u96C6\u9875\uFF083 \u8F6E\u6570\u5B57\u6717\u8BFB\u6311\u6218\uFF09",
    "services.bioVoiceOff": "\u5173\u95ED\u8BED\u97F3",
    "services.bioVoiceOffHint": "\u5220\u9664\u5DF2\u5B58\u7684\u8BED\u97F3\u6A21\u677F",
    "services.bioVoiceOn": "\u8BED\u97F3\u5DF2\u5F00",
    "services.totpActivate": "Activate",
    "services.activating": "Activating\u2026",
    "services.totpActivateFailed": "Invalid code",
    "services.totpEnrollFailed": "Enrollment failed",
    "services.totpApps": "Authenticator apps (CN-store friendly)",
    "services.totpAppMs": "Microsoft Authenticator",
    "services.totpAppCnStore": "(installable from CN stores: Huawei/Xiaomi/AppBao)",
    "services.totpAppTencent": "Tencent Authenticator (search app stores)",
    "services.totpAppGoogle": "Google Authenticator",
    "services.docs": "Docs",
    "services.totpApkMirror": "CN mirror APK download (SHA-256 verified)",
    "services.otpauthOpen": "otpauth://\u2026 (open in authenticator)",
    "services.officialSite": "Official site",
    "services.appStore": "App Store",
    "services.noUsers": "No users yet \u2014 add the first one below.",
    "services.adding": "Adding\u2026",
    "services.updating": "Updating\u2026",
    "services.exposing": "Exposing\u2026",
    "services.exposeDone": "Done",
    "services.exposeFailed": "Expose failed",
    "services.providerChanged": "Switched provider",
    "services.title": "Service ports",
    "services.tabPorts": "Ports",
    "services.tabUsers": "Users",
    "services.tabSelf": "Pi-web",
    "services.selfAccessUrls": "Access URLs",
    "services.selfUrl.loopback": "Loopback",
    "services.selfUrl.lan": "LAN ({name})",
    "services.selfUrl.vhostLocal": "Service vhost (local)",
    "services.selfUrl.vhostBase": "Service vhost (base domain)",
    "services.selfUrl.tunnel": "Tunnel (public)",
    "services.selfUrl.allowhost": "Allowed host (allowHost)",
    "services.selfExpose": "Expose pi-web itself",
    "services.selfExposeUrls": "Exposed addresses (auth entries):",
    "services.selfExposeHint": "Opens an authenticated public entry (portal/basic/authelia). External users reach pi-web only through this gateway; direct 127/LAN access is governed by the allowlocal switch below.",
    "services.selfExposing": "exposing",
    "services.selfNotExposing": "not exposing",
    "services.selfMode": "Mode",
    "services.selfAuth": "Auth",
    "services.selfTunnel": "Tunnel",
    "services.selfExposeBtn": "Expose",
    "services.selfStopTunnel": "Stop",
    "services.selfStopTunnelHint": "Stop this tunnel channel (vhost entry stays)",
    "services.selfStopVhostHint": "Stop this vhost channel (removes the binding; tunnel entry stays)",
    "services.selfAllowLocal": "Allow direct local access (allowlocal)",
    "services.selfAllowLocalHint": "When OFF, LAN / public / loopback direct requests to this port are refused (403) \u2014 only the authenticated gateway works: virtual-host domains and self tunnel domains are routed through the proxy auth. Loopback (127.0.0.1/localhost) is affected too (only the gateway-authenticated self-exposure forward passes).",
    "services.selfAllowHosts": "Allowed hosts (allowHost)",
    "services.selfAllowHostsHint": "Hostnames allowed to reach pi-web directly even when allowlocal=false \u2014 your own reverse-proxy fronts. Only the hosts you list here count (deployment domains are NOT auto-allowed: they must go through the proxy auth or be listed explicitly).",
    "services.selfAllowHostsCurrent": "Currently allowed",
    "services.selfAllowHostsSave": "Save",
    "services.selfGatedHint": "allowlocal=false: direct access is refused (403) \u2014 use the vhost/tunnel auth entry instead",
    "services.selfNotExposingHint": "pi-web is not exposed: with allowlocal=false, direct requests to this port (including loopback) are refused (403) \u2014 open an entry via an exposure method below (vhost / tunnel) first.",
    "services.lockoutTitle": "allowlocal temporarily off \u2014 auto-restores in {ttl}s",
    "services.lockoutCountdown": "Direct local access is temporarily disabled. It auto-restores in {ttl}s. Verify you can still reach pi-web (open an entry below to check login), then confirm within {window}s to keep it off permanently \u2014 otherwise it reverts automatically.",
    "services.lockoutAutoRestore": "No action \u2192 allowlocal auto-restores (nothing is locked).",
    "services.lockoutBlockedHint": "Direct access is now blocked (403) \u2014 this action needs an authenticated entry (vhost/tunnel). Waiting for auto-restore in ~{ttl}s, or use one of the reachable entries below.",
    "services.lockoutStillWorks": "Still reachable while off:",
    "services.lockoutVerify": "Open & verify login",
    "services.lockoutRestore": "Restore now",
    "services.lockoutConfirm": "Confirm: keep off",
    "services.lockoutNoEntryTitle": "Cannot turn off direct access",
    "services.lockoutNoEntry": "There is no reachable entry while it is off: pi-web is not exposed (no vhost/tunnel) and no allowHost exception is configured. Turning it off would lock you out. Expose pi-web (vhost/tunnel auth entry) or add allowHost domains first.",
    "services.lockoutRestored": "allowlocal restored (true) \u2014 direct access works again",
    "services.copy": "Copy",
    "services.selfEnvHint": "Permanent config \u2014 copy to your start script:",
    "services.selfEnvNote": "UI changes are one-shot; they reset on restart. Set PI_WEB_EXPOSE in the environment to persist.",
    "services.selfWarning": "pi-web is exposing while reachable at a non-loopback address \u2014 direct LAN access bypasses gateway auth. Prefer listening on 127.0.0.1 only, or keep a password set.",
    "services.selfNoAuth": "Self-exposure without authentication",
    "services.selfNoAuthSummary": "anyone with the URL can fully control pi-web (run commands, read/write files) \u2014 data-leak risk",
    "services.selfNoAuthReason": "Why this matters",
    "services.selfNoAuthBody": "pi-web hosts agent sessions that can run arbitrary commands and read/write your files. The current self-exposure is NOT protected by any gateway auth (auth=none): anyone with the URL can fully control pi-web. Even with allowlocal off, open vhost/tunnel entries remain reachable via the deployment domain.",
    "services.selfNoAuthSuggest": "Switch to an authenticated expose method: in Services \u2192 Expose pi-web itself, change auth from none to portal / basic (or authelia) and make sure the site has a loggable user (2FA available)\\nOr use proxy-only mode (local vhost, governed by the allowlocal / password gate), without a tunnel\\nOr stop exposing now and re-configure later",
    "services.selfNoAuthOpen": "Switch expose method",
    "services.selfNoAuthStop": "Stop exposing now",
    "services.selfNoAuthDismiss": "Don't show again this session",
    "services.auto": "Auto-refresh every 10s",
    "services.autoOff": "Auto refresh off",
    "services.loading": "Scanning...",
    "services.none": "No service ports found. Servers started by pi sessions appear here automatically.",
    "services.open": "Open",
    "services.refresh": "Refresh",
    "services.ngrokAuthtoken": "ngrok authtoken",
    "services.ngrokAuthtokenPlaceholder": "paste NGROK_AUTHTOKEN (required)",
    "services.ngrokAuthtokenGet": "get token",
    "services.error": "Failed to scan service ports",
    "services.close": "Close",
    "services.direct": "Direct (bypass pi-web)",
    "services.viaProxy": "Via pi-web (virtual host)",
    "services.proxyLocal": "local proxy",
    "services.proxyDomain": "domain",
    "services.proxyDeploy": "deployment",
    "services.listenOn": "Listening on",
    "services.sameMachine": "same machine",
    "services.currentDomain": "current domain",
    "services.infoAccess": "How other devices reach these services (DNS / wildcard domain)",
    "services.infoAuth": "Authentication guide",
    "services.exposeLocal": "Same machine: *.pi.localhost zero-config (RFC 6761).",
    "services.exposeLan": 'LAN: add "address=/pi.lan/<server-ip>" to dnsmasq, then set PI_WEB_SVC_HOST_SUFFIX=.pi.lan and PI_WEB_ALLOWED_HOSTS=pi.lan.',
    "services.exposePublic": "Public domain: wildcard A record *.pi.example.com \u2192 server IP, add the domain to PI_WEB_ALLOWED_HOSTS.",
    "services.exposeTunnel": "Tunnels expose ONE service port (or its virtual-host subdomain) \u2014 never pi-web itself. Pick a tunnel type + auth provider in the port card's \u201CPublic access\u201D section to expose in place. Never point a tunnel at pi-web's own port: the host gate would 403 it unless whitelisted, and whitelisting it would expose pi-web unauthenticated.",
    "services.tunnelStatus": "Tunnel",
    "services.tunnelRunning": "running",
    "services.tunnelStopped": "exited",
    "services.tunnelStart": "Start",
    "services.tunnelStop": "Stop",
    "services.portTunnel": "Tunnel this port (exposes only it)",
    "services.activePortTunnels": "Open port tunnels",
    "services.activeExposes": "Active exposes",
    "services.details": "Details",
    "services.needsAuth": "needs token",
    "services.needsAuthHint": "Free signup at ngrok.com, then run: ngrok config add-authtoken <token>",
    "services.portTunnelHint": "Only this port is exposed. Never tunnel pi-web itself without authentication.",
    "services.authHint": "Add HTTPS and authentication in front of pi-web (or the tunnel) before exposing anything.",
    "services.authBuiltinTitle": "Built-in (selectable in the port card's \u201CExpose now\u201D)",
    "services.authBuiltinPortal": "portal \u2014 built-in auth portal: user management + TOTP 2FA (manage users in the Users tab)",
    "services.authBuiltinBasic": "basic \u2014 HTTP Basic auth: username + password",
    "services.authBuiltinAuthelia": "authelia \u2014 self-hosted Authelia via forward_auth (unavailable on Windows)",
    "services.authExtendTitle": "Extendable \u2014 configure in front of pi-web / the tunnel (nginx or Caddy)",
    "services.authExtendList": "Authentik \u2014 open-source identity platform (OIDC/SAML/LDAP)\\noauth2-proxy \u2014 lightweight reverse-proxy auth via Google/GitHub/OIDC\\nKeycloak \u2014 enterprise IAM (heavier)\\nCloudflare Access \u2014 managed zero-trust gateway",
    "services.configCurrent": "This page is served from {host} \u2014 {host} virtual hosts are enabled automatically, e.g. http://<port>{host}{pagePort}{basePath}."
  },
  "zh-CN": {
    "services.exposeSection": "\u516C\u7F51\u8BBF\u95EE\uFF08\u8BA4\u8BC1\u7F51\u5173\uFF09",
    "services.exposeLoading": "\u52A0\u8F7D\u914D\u7F6E\u4E2D\u2026",
    "services.exposeMode": "\u6A21\u5F0F",
    "services.exposeModeTunnel": "tunnel\uFF08\u516C\u7F51\u96A7\u9053\uFF09",
    "services.exposeModeProxy": "proxy\uFF08\u672C\u5730\u865A\u62DF\u4E3B\u673A\uFF0C\u65E0\u96A7\u9053\uFF09",
    "services.exposeModeBoth": "both\uFF08\u672C\u5730 + \u96A7\u9053\uFF09",
    "services.exposeSite": "\u7AD9\u70B9\uFF08\u8BA4\u8BC1\u57DF\uFF09",
    "services.exposeBasePath": "Base path\uFF08\u670D\u52A1\uFF09",
    "services.exposeSiteDefault": "default",
    "services.allowToolDownload": "\u5141\u8BB8\u5728\u7EBF\u4E0B\u8F7D\u5DE5\u5177",
    "services.allowToolDownloadHint": "\u5173\u95ED\u540E\u4EC5\u4F7F\u7528\u672C\u673A\u5DF2\u5B89\u88C5\u7684\u5DE5\u5177\uFF0C\u7F3A\u5C11\u7684\u5DE5\u5177\u4E0D\u4F1A\u81EA\u52A8\u4E0B\u8F7D\u3002",
    "services.toolsMissing": "\u7F3A\u5931",
    "services.exposeProtocol": "\u534F\u8BAE",
    "services.selectProvider": "\u9009\u62E9\u8BA4\u8BC1\u65B9\u5F0F\u2026",
    "services.exposeProvider": "\u8BA4\u8BC1 provider",
    "services.exposeProviderNone": "none\uFF08\u65E0\u8BA4\u8BC1\uFF09",
    "services.fixedParamHint": "\u9884\u5B9A\u4E49\u56FA\u5B9A\u53C2\u6570\uFF08\u53EA\u8BFB\uFF09",
    "services.provider.oauth2-github": "GitHub OAuth",
    "services.provider.oauth2-google": "Google OAuth",
    "services.provider.oauth2-gitlab": "GitLab OAuth",
    "services.provider.oauth2-microsoft": "Microsoft Entra ID",
    "services.provider.oauth2-keycloak": "Keycloak",
    "services.provider.oauth2-okta": "Okta",
    "services.provider.oauth2-generic": "\u901A\u7528 OIDC",
    "services.noAuthWarnHint": "\u65E0\u8BA4\u8BC1\u4FDD\u62A4\uFF1A\u4EFB\u4F55\u4EBA\u62FF\u5230\u5730\u5740\u5373\u53EF\u8BBF\u95EE\uFF0C\u5B58\u5728\u6570\u636E\u6CC4\u9732\u98CE\u9669",
    "services.exposeLogs": "\u65E5\u5FD7",
    "services.exposeLogsHide": "\u6536\u8D77\u65E5\u5FD7",
    "services.exposeStop": "\u505C\u6B62",
    "services.exposeStopHint": "\u4EC5\u505C\u6B62\u5F53\u524D\u8FD9\u6761\u901A\u9053(\u540C\u7AEF\u53E3\u7684\u5176\u4ED6\u66B4\u9732\u4E0D\u53D7\u5F71\u54CD)",
    "services.confirmNoAuthTitle": "\u65E0\u8BA4\u8BC1\u4FDD\u62A4(\u6CC4\u9732\u98CE\u9669)",
    "services.confirmNoAuthBodyPort": "\u6240\u9009\u65B9\u5F0F\u4E0D\u542F\u7528\u7F51\u5173\u8BA4\u8BC1,\u7AEF\u53E3 {port} \u5C06\u76F4\u63A5\u5BF9\u5916\u516C\u5F00,\u4EFB\u4F55\u4EBA\u62FF\u5230\u5730\u5740\u5373\u53EF\u8BBF\u95EE,\u5B58\u5728\u6570\u636E\u6CC4\u9732\u98CE\u9669\u3002\u786E\u5B9A\u7EE7\u7EED\u5417?",
    "services.confirmNoAuthBodySelf": "\u6240\u9009\u65B9\u5F0F\u4E0D\u542F\u7528\u7F51\u5173\u8BA4\u8BC1,pi-web \u7BA1\u7406\u754C\u9762\u5C06\u76F4\u63A5\u5BF9\u5916\u516C\u5F00,\u4EFB\u4F55\u4EBA\u62FF\u5230\u5730\u5740\u5373\u53EF\u8BBF\u95EE,\u5B58\u5728\u6570\u636E\u6CC4\u9732\u98CE\u9669\u3002\u786E\u5B9A\u7EE7\u7EED\u5417?",
    "services.exposeConfirm": "\u786E\u8BA4\u516C\u5F00",
    "services.exposeAbort": "\u53D6\u6D88",
    "services.userCheckUnavailable": "\u65E0\u6CD5\u786E\u8BA4\u8BA4\u8BC1\u7528\u6237\u6E05\u5355,\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5",
    "services.confirmNoUsersTitle": "\u65E0\u53EF\u7528\u7684\u8BA4\u8BC1\u7528\u6237",
    "services.confirmNoUsersBody": "provider\u300C{provider}\u300D\xB7 \u7AD9\u70B9\u300C{site}\u300D\u4E0B\u6682\u65E0\u7528\u6237\u3002\u8BF7\u5148\u5230\u300C\u7528\u6237\u300D\u9875\u6DFB\u52A0\u7528\u6237(\u9009\u62E9\u76F8\u540C\u7684 provider \u4E0E\u7AD9\u70B9),\u518D\u56DE\u6765\u516C\u5F00\u3002",
    "services.confirmNoUsersGo": "\u53BB\u7BA1\u7406\u7528\u6237",
    "services.confirmUsersTitle": "\u786E\u8BA4\u4F60\u53EF\u4EE5\u767B\u5F55",
    "services.confirmUsersBody": "\u4EE5\u4E0B\u8D26\u53F7\u53EF\u767B\u5F55\u8BE5\u8BA4\u8BC1\u7F51\u5173(provider\u300C{provider}\u300D\xB7 \u7AD9\u70B9\u300C{site}\u300D)\u3002\u8BF7\u786E\u8BA4\u4F60\u6301\u6709\u5176\u4E2D\u81F3\u5C11\u4E00\u4E2A\u8D26\u53F7\u7684\u5BC6\u7801\u2014\u2014\u516C\u5F00\u540E\u9700\u7528\u5B83\u8BBF\u95EE\u3002",
    "services.confirmUsersConfirm": "\u786E\u8BA4\u53EF\u767B\u5F55,\u7EE7\u7EED\u516C\u5F00",
    "services.exposeAuth": "\u8981\u6C42\u767B\u5F55",
    "services.exposeTunnelTool": "\u96A7\u9053",
    "services.tunnelParams": "\u96A7\u9053\u53C2\u6570",
    "services.recommended": "\u63A8\u8350",
    "services.authParams": "\u8BA4\u8BC1\u53C2\u6570",
    "services.exposeGo": "\u7ACB\u5373\u516C\u5F00",
    "services.preset": "\u65B9\u6848",
    "services.presetHint": "\u9009\u62E9\u5DF2\u4FDD\u5B58\u7684\u65B9\u6848\u76F4\u63A5\u5E26\u56DE\u5168\u90E8\u914D\u7F6E\uFF1B\u6BCF\u6B21\u6253\u5F00\u65F6\u81EA\u52A8\u56DE\u586B\u4E0A\u6B21\u4F7F\u7528\u7684\u9009\u9879",
    "services.presetLastUsed": "\u4E0A\u6B21\u4F7F\u7528",
    "services.presetLastUsedNone": "\u4E0A\u6B21\u4F7F\u7528\uFF08\u6682\u65E0\uFF09",
    "services.presetSaveAs": "\u53E6\u5B58\u4E3A\u65B9\u6848",
    "services.presetActionsEnroll": "\u767B\u8BB0\u7AEF\u53E3\uFF08vhost \u53EF\u8FBE\uFF09",
    "services.presetActionsEnrollHint": "\u5E94\u7528\u65B9\u6848\u65F6\u81EA\u52A8\u767B\u8BB0\u8BE5\u7AEF\u53E3\u4E3A open vhost\uFF08\u5E26\u5F53\u524D Base Path\uFF09",
    "services.presetActionsExpose": "\u7ACB\u5373\u516C\u5F00",
    "services.presetActionsExposeHint": "\u5E94\u7528\u65B9\u6848\u65F6\u81EA\u52A8\u6309\u672C\u65B9\u6848\u516C\u5F00\uFF08\u6709\u8BA4\u8BC1\u786E\u8BA4\u6D41\u7A0B\uFF09",
    "services.presetActionsInject": "\u5F00\u542F\u6CE8\u5165\u6E90",
    "services.presetActionsInjectHint": "\u5E94\u7528\u65B9\u6848\u65F6\u81EA\u52A8\u5F00\u542F\u5F53\u524D\u5DF2\u52FE\u9009\u7684\u6CE8\u5165\u6E90",
    "services.presetActionsInjectNone": "\u65E0\u5DF2\u5F00\u542F\u6CE8\u5165\u6E90",
    "services.presetSaveAsHint": "\u628A\u5F53\u524D\u8868\u5355\u9009\u9879\u4FDD\u5B58\u4E3A\u547D\u540D\u65B9\u6848\uFF08\u654F\u611F\u53C2\u6570\u52A0\u5BC6\u5B58\u50A8\uFF09",
    "services.presetSave": "\u4FDD\u5B58",
    "services.presetNamePlaceholder": "\u65B9\u6848\u540D\u79F0",
    "services.presetDelete": "\u5220\u9664",
    "services.presetDeleteHint": "\u5220\u9664\u8BE5\u65B9\u6848\uFF08\u8868\u5355\u5185\u5BB9\u4FDD\u6301\u4E0D\u53D8\uFF09",
    "services.presetLoadFailed": "\u65B9\u6848\u52A0\u8F7D\u5931\u8D25",
    "services.exposeResult": "\u8BBF\u95EE\u5730\u5740",
    "services.injectJs": "\u6CE8\u5165 JS",
    "services.injectJsEnable": "\u5F00\u542F\u6CE8\u5165",
    "services.injectJsOn": "\u6CE8\u5165\u5DF2\u5F00\u542F",
    "services.injectJsEnableHint": "\u5F00\u542F\u540E\uFF0C\u7ECF\u8BE5\u7AEF\u53E3\u8BBF\u95EE\u901A\u9053\uFF08\u670D\u52A1\u865A\u62DF\u4E3B\u673A/\u96A7\u9053\uFF09\u8FD4\u56DE\u7684 HTML \u81EA\u52A8\u6CE8\u5165 aiti-launcher.js\uFF0C\u9875\u9762\u5185\u51FA\u73B0\u8C03\u8BD5\u5668",
    "services.injectJsDisableHint": "\u5173\u95ED\u540E\u4E0D\u518D\u6CE8\u5165\u8C03\u8BD5\u5668",
    "services.injectJsBasePath": "Base Path",
    "services.injectJsBasePathHint": "\u670D\u52A1\u771F\u5B9E\u90E8\u7F72\u7684\u524D\u7F00\uFF08\u5982 vite base=/dev/ \u586B dev\uFF09\uFF1Avhost \u4EE3\u7406\u5265\u90E8\u7F72\u524D\u7F00\u540E\u63A5\u56DE\u5B83\u3002\u7559\u7A7A = \u6839\u8DEF\u5F84\u670D\u52A1",
    "services.injectJsBasePathPlaceholder": "\u5982 dev\uFF08\u7559\u7A7A = /\uFF09",
    "services.injectJsModeProxy": "proxy \u6A21\u5F0F\uFF08\u670D\u52A1\u865A\u62DF\u4E3B\u673A\uFF09\uFF1A\u5DF2\u751F\u6548",
    "services.injectJsModeTunnel": "tunnel \u6A21\u5F0F\uFF1A\u7ECF nginx \u7F51\u5173\u9759\u6001\u6CE8\u5165\uFF08\u4EC5\u4E3B\u9875\u9762\u5BFC\u822A\uFF09",
    "services.injectJsUnavailable": "aiti-devtools \u6269\u5C55\u672A\u52A0\u8F7D\uFF0C\u65E0\u6CD5\u7BA1\u7406\u6CE8\u5165",
    "services.injectJsSelfHint": "\u5F00\u542F\u540E\uFF0C\u7ECF\u865A\u62DF\u4E3B\u673A/\u96A7\u9053\u8BBF\u95EE pi-web \u9875\u9762\u65F6\u81EA\u52A8\u6CE8\u5165\u8C03\u8BD5\u5668\uFF08\u4EC5\u7ECF\u8BA4\u8BC1\u5165\u53E3\uFF1B\u672C\u673A\u76F4\u8FDE\u4E0D\u6CE8\u5165\uFF09",
    "services.enrolledExt": "\u5DF2\u767B\u8BB0\u7684\u5916\u90E8\u7AEF\u53E3",
    "services.enrolledExtHint": "\u4E0D\u5728 pi-web \u8FDB\u7A0B\u6811\u3001\u4F46\u7ECF aiti \u6CE8\u5165\u767B\u8BB0\u4E86 open vhost \u7684\u7AEF\u53E3\uFF08\u5982 systemd/\u624B\u52A8\u542F\u52A8\u7684 dev server\uFF09\u2014\u2014\u8FDB\u7A0B\u626B\u63CF\u770B\u4E0D\u5230\uFF0C\u4F46 vhost \u4EE3\u7406\u786E\u5B9E\u5728\u66B4\u9732\u3002\u53D6\u6D88\u767B\u8BB0\u5373\u5173\u95ED vhost \u4EE3\u7406\u4E0E\u6CE8\u5165\uFF08\u670D\u52A1\u8FDB\u7A0B\u672C\u8EAB\u4E0D\u53D7\u5F71\u54CD\uFF09",
    "services.enrolledExtNotTree": "\u5916\u90E8\u8FDB\u7A0B",
    "services.enrolledBasePathHint": "\u670D\u52A1\u7684 basePath\uFF1Avhost \u4EE3\u7406\u5265\u90E8\u7F72\u524D\u7F00\u540E\u63A5\u56DE\u6B64\u524D\u7F00",
    "services.enrolledUnenroll": "\u53D6\u6D88\u767B\u8BB0",
    "services.enrolledUnenrollHint": "\u4ECE\u6CE8\u5165\u767B\u8BB0\u4E2D\u79FB\u9664\uFF1Avhost \u4EE3\u7406\uFF08<port>.\u57DF\u540D\uFF09\u4E0E HTML \u6CE8\u5165\u540C\u65F6\u5173\u95ED\uFF1B\u670D\u52A1\u8FDB\u7A0B\u672C\u8EAB\u4E0D\u53D7\u5F71\u54CD",
    "services.exposeDetail": "\u8BE6\u60C5",
    "services.exposeDetailHint": "\u70B9\u51FB\u94FE\u63A5\u5728\u65B0\u7A97\u53E3\u6253\u5F00;\u505C\u6B62\u4EC5\u505C\u6B62\u8FD9\u4E00\u6761\u901A\u9053",
    "services.exposeStartedAt": "\u5F00\u542F\u65F6\u95F4",
    "services.exposeParams": "\u53C2\u6570",
    "services.exposeLogFiles": "\u65E5\u5FD7\u6587\u4EF6",
    "services.exposeLogFilesLoading": "\u52A0\u8F7D\u4E2D\u2026",
    "services.exposeNoLogs": "\u65E0\u65E5\u5FD7\u6587\u4EF6",
    "services.openLogin": "\u6253\u5F00\u767B\u5F55\u9875",
    "services.authUsers": "\u8BA4\u8BC1\u4E0E\u7528\u6237",
    "services.usersPickCombo": "\u7528\u6237\u6309\u7AD9\u70B9\u4E0E\u8BA4\u8BC1\u65B9\u5F0F\u5206\u5F00\u7EF4\u62A4\u3002\u70B9\u51FB\u4E00\u884C\u7BA1\u7406\u8BE5\u7EC4\u5408\u7684\u7528\u6237\u3002",
    "services.usersSite": "\u7AD9\u70B9",
    "services.usersAuth": "\u8BA4\u8BC1",
    "services.usersCount": "\u7528\u6237\u6570",
    "services.usersTotpCount": "TOTP \u7528\u6237\u6570",
    "services.usersEditing": "\u6B63\u5728\u7F16\u8F91",
    "services.noUserCombos": "\u6682\u65E0\u53EF\u7528\u7EC4\u5408",
    "services.usersBack": "\u8FD4\u56DE\u603B\u8868",
    "services.sitesManage": "\u7AD9\u70B9\uFF08\u8BA4\u8BC1\u57DF\uFF09",
    "services.sitesManageHint": "\u6BCF\u4E2A\u7AD9\u70B9\u662F\u72EC\u7ACB\u8BA4\u8BC1\u57DF\uFF08\u72EC\u7ACB provider \u4E0E\u7528\u6237\u5E93\uFF09\uFF0C\u516C\u5F00\u65F6\u53EF\u9009\uFF1B\u7528\u6237\u5728\u4E0B\u65B9\u8868\u683C\u6309\u7AD9\u70B9\u7EF4\u62A4\u3002\u53D7\u4FDD\u62A4\u7AD9\u70B9\u4E3A\u5185\u7F6E\u4F9D\u8D56\uFF0C\u4E0D\u53EF\u5220\u9664\u3002",
    "services.sitesProtected": "\u53D7\u4FDD\u62A4",
    "services.sitesProtectedHint": "\u5185\u7F6E\u4FDD\u62A4\u7AD9\u70B9\uFF08default \u9690\u5F0F\u7AD9\u70B9 / self \u9875\u9ED8\u8BA4\u8BA4\u8BC1\u57DF pi-web\uFF09\uFF0C\u4E0D\u53EF\u5220\u9664",
    "services.sitesRemove": "\u5220\u9664",
    "services.sitesRemoveHint": "\u5220\u9664\u8BE5\u7AD9\u70B9\uFF08\u7528\u6237\u5E93\u4E0E\u8BA4\u8BC1\u914D\u7F6E\u4E00\u5E76\u79FB\u9664\uFF09",
    "services.sitesRemoveConfirm": "\u786E\u5B9A\u5220\u9664\u7AD9\u70B9\u300C{name}\u300D\uFF1F\u8BE5\u7AD9\u70B9\u7684\u7528\u6237\u5E93\u4E0E\u8BA4\u8BC1\u914D\u7F6E\u5C06\u4E00\u5E76\u79FB\u9664\uFF1B\u5DF2\u516C\u5F00\u7684\u901A\u9053\u4E0D\u53D7\u5F71\u54CD\uFF0C\u505C\u6B62\u540E\u624D\u5173\u95ED\u3002",
    "services.sitesRemoveConfirmGo": "\u786E\u8BA4\u5220\u9664",
    "services.sitesAdd": "\u6DFB\u52A0\u7AD9\u70B9",
    "services.sitesNamePlaceholder": "\u65B0\u7AD9\u70B9\u540D\uFF08\u5982 team-a\uFF09",
    "services.sitesProviderAuto": "auto\uFF08\u5E73\u53F0\u9ED8\u8BA4\uFF09",
    "services.userList": "\u7528\u6237",
    "services.addUser": "\u6DFB\u52A0\u7528\u6237",
    "services.userName": "\u7528\u6237\u540D",
    "services.userPassword": "\u5BC6\u7801",
    "services.userDisplayName": "\u663E\u793A\u540D",
    "services.userRemove": "\u5220\u9664",
    "services.userSetPassword": "\u8BBE\u7F6E\u5BC6\u7801",
    "services.newPassword": "\u65B0\u5BC6\u7801",
    "services.update": "\u66F4\u65B0",
    "services.totpEnroll": "\u5F00\u542F 2FA(TOTP)",
    "services.totpEnrollConfirm": "\u786E\u8BA4\u5F00\u542F",
    "services.totpLabelHint": "2FA \u6807\u8BC6\uFF08authenticator \u4E2D\u663E\u793A\uFF0C\u53EF\u4FEE\u6539\uFF09",
    "services.totpLabelPlaceholder": "user1-portal-site@host",
    "services.totpDisable": "\u5173\u95ED 2FA(TOTP)",
    "services.totpEnrolled": "2FA(TOTP) \u5DF2\u5F00",
    "services.totpOff": "2FA(TOTP) \u672A\u5F00",
    "services.totpSecret": "\u7528\u8EAB\u4EFD\u9A8C\u8BC1\u5668 App \u626B\u7801\u7ED1\u5B9A",
    "services.totpManual": "\u6216\u624B\u52A8\u8F93\u5165\u5BC6\u94A5",
    "services.totpActivateHint": "\u8F93\u5165\u9A8C\u8BC1\u5668\u4E2D\u7684 6 \u4F4D\u9A8C\u8BC1\u7801\u5B8C\u6210\u6FC0\u6D3B\u2014\u2014\u9A8C\u8BC1\u901A\u8FC7\u524D\u4E0D\u4F1A\u5F3A\u5236 2FA\u3002",
    "services.totpCode": "6 \u4F4D\u9A8C\u8BC1\u7801",
    "services.bioPortalNotRunning": "\u6CE8\u518C\u7968\u5DF2\u7B7E\u53D1\uFF0C\u4F46\u95E8\u6237\u672A\u8FD0\u884C\u2014\u2014\u8BF7\u5148\u4EE5\u8BE5\u8BA4\u8BC1\u505A\u4E00\u6B21\u516C\u5F00\uFF0C\u518D\u6253\u5F00\u91C7\u96C6\u9875",
    "services.bioFacePreparing": "\u6B63\u5728\u51C6\u5907\u4EBA\u8138\u6CE8\u518C\u2026",
    "services.bioFaceCaptureTitle": "\u4EBA\u8138\u6CE8\u518C",
    "services.bioFaceCaptureHint": "\u770B\u6444\u50CF\u5934\uFF0C\u5F20\u4E00\u6B21\u5634\u91C7\u96C6\u4E00\u5E27\uFF08\u5171 3 \u5E27\uFF09\u3002\u6A21\u677F\u9996\u6B21\u4EBA\u8138\u767B\u5F55\u9A8C\u8BC1\u540E\u6B63\u5F0F\u751F\u6548\u3002",
    "services.bioFaceCam": "\u6444\u50CF\u5934",
    "services.bioFaceCamAuto": "\u81EA\u52A8",
    "services.bioFaceCamError": "\u6444\u50CF\u5934\u4E0D\u53EF\u7528\uFF1A",
    "services.bioFaceProgress": "\u5F20\u5634 {n}/3",
    "services.bioFaceSaving": "\u6B63\u5728\u4FDD\u5B58\u6A21\u677F\u2026",
    "services.bioFacePending": "\u4EBA\u8138\u5F85\u9A8C\u8BC1",
    "services.bioFacePendingHint": "\u6A21\u677F\u5DF2\u4FDD\u5B58\u2014\u2014\u9996\u6B21\u4EBA\u8138\u767B\u5F55\u9A8C\u8BC1\u901A\u8FC7\u540E\u751F\u6548",
    "services.bioVoicePending": "\u8BED\u97F3\u5F85\u9A8C\u8BC1",
    "services.bioVoicePendingHint": "\u6A21\u677F\u5DF2\u4FDD\u5B58\u2014\u2014\u9996\u6B21\u8BED\u97F3\u767B\u5F55\u9A8C\u8BC1\u901A\u8FC7\u540E\u751F\u6548",
    "services.bioFaceVerify": "\u73B0\u5728\u9A8C\u8BC1",
    "services.bioFaceRerecord": "\u91CD\u65B0\u8BB0\u5F55",
    "services.bioFaceRerecordFace": "\u91CD\u5F55\u4EBA\u8138",
    "services.bioFaceRerecordHint": "\u91CD\u65B0\u91C7\u96C6\u4EBA\u8138\u6A21\u677F\uFF08\u66FF\u6362\u5F53\u524D\u6A21\u677F\uFF09",
    "services.bioFaceRecorded": "\u8BB0\u5F55\u5B8C\u6210\uFF0C\u5F85\u9A8C\u8BC1",
    "services.bioFaceVerified": "\u9A8C\u8BC1\u901A\u8FC7",
    "services.bioFaceActiveHint": "\u4EBA\u8138\u6A21\u677F\u5DF2\u751F\u6548\u2014\u2014\u767B\u5F55\u65F6\u53EF\u7528",
    "services.bioFaceVerifyProgress": "\u5F20\u5634 {n}/1",
    "services.on": "\u5F00",
    "services.off": "\u5173",
    "services.loginInfoButton": "\u663E\u793A\u767B\u5F55\u4FE1\u606F\uFF08\u9875\u9762\u53F3\u4E0B\u89D2\u6309\u94AE\uFF1A\u7528\u6237\u540D + \u9000\u51FA\u767B\u5F55\uFF0C\u53EF\u62D6\u52A8\uFF09",
    "services.loginInfoButtonHint": "\u5728\u53D7\u4FDD\u62A4\u9875\u9762\u6CE8\u5165\u60AC\u6D6E\u6309\u94AE\uFF1A\u663E\u793A\u767B\u5F55\u7528\u6237\u540D + \u9000\u51FA\u767B\u5F55\uFF1B\u53EF\u62D6\u52A8\u5230\u5C4F\u5E55\u56DB\u8FB9\u505C\u9760",
    "services.save": "\u4FDD\u5B58",
    "services.cancel": "\u53D6\u6D88",
    "services.displayNameEditHint": "\u70B9\u51FB\u4FEE\u6539\u663E\u793A\u540D\uFF08\u6635\u79F0\uFF09",
    "services.bioFaceEnroll": "\u5F00\u542F\u4EBA\u8138 2FA",
    "services.bioFaceHint": "\u6253\u5F00\u4EBA\u8138\u91C7\u96C6\u9875\uFF08\u6D4F\u89C8\u5668\u6444\u50CF\u5934\uFF1B\u9996\u6B21\u9A8C\u8BC1\u901A\u8FC7\u540E\u6A21\u677F\u8F6C\u6B63\uFF09",
    "services.bioFaceOff": "\u5173\u95ED\u4EBA\u8138",
    "services.bioFaceOffHint": "\u5220\u9664\u5DF2\u5B58\u7684\u4EBA\u8138\u6A21\u677F",
    "services.bioFaceOn": "\u4EBA\u8138\u5DF2\u5F00",
    "services.bioVoiceEnroll": "\u5F00\u542F\u8BED\u97F3 2FA",
    "services.bioVoiceHint": "\u6253\u5F00\u8BED\u97F3\u91C7\u96C6\u9875\uFF083 \u8F6E\u6570\u5B57\u6717\u8BFB\u6311\u6218\uFF09",
    "services.bioVoiceOff": "\u5173\u95ED\u8BED\u97F3",
    "services.bioVoiceOffHint": "\u5220\u9664\u5DF2\u5B58\u7684\u8BED\u97F3\u6A21\u677F",
    "services.bioVoiceOn": "\u8BED\u97F3\u5DF2\u5F00",
    "services.totpActivate": "\u6FC0\u6D3B",
    "services.activating": "\u6FC0\u6D3B\u4E2D\u2026",
    "services.totpActivateFailed": "\u9A8C\u8BC1\u7801\u65E0\u6548",
    "services.totpEnrollFailed": "\u767B\u8BB0\u5931\u8D25",
    "services.totpApps": "\u56FD\u5185\u53EF\u5B89\u88C5\u7684\u8EAB\u4EFD\u9A8C\u8BC1\u5668 App",
    "services.totpAppMs": "Microsoft Authenticator",
    "services.totpAppCnStore": "\uFF08\u534E\u4E3A/\u5C0F\u7C73/\u5E94\u7528\u5B9D\u7B49\u56FD\u5185\u5546\u5E97\u53EF\u76F4\u63A5\u5B89\u88C5\uFF09",
    "services.totpAppTencent": "\u817E\u8BAF\u8EAB\u4EFD\u9A8C\u8BC1\u5668\uFF08\u5E94\u7528\u5546\u5E97\u641C\u7D22\u5B89\u88C5\uFF09",
    "services.totpAppGoogle": "Google Authenticator",
    "services.docs": "\u6587\u6863",
    "services.totpApkMirror": "\u56FD\u5185\u955C\u50CF APK \u4E0B\u8F7D\uFF08SHA-256 \u5DF2\u6821\u9A8C\uFF09",
    "services.otpauthOpen": "otpauth://\u2026\uFF08\u5728\u8EAB\u4EFD\u9A8C\u8BC1\u5668\u4E2D\u6253\u5F00\uFF09",
    "services.officialSite": "\u5B98\u7F51",
    "services.appStore": "App Store",
    "services.noUsers": "\u6682\u65E0\u7528\u6237\u2014\u2014\u5728\u4E0B\u65B9\u6DFB\u52A0\u7B2C\u4E00\u4E2A\u3002",
    "services.adding": "\u6DFB\u52A0\u4E2D\u2026",
    "services.updating": "\u66F4\u65B0\u4E2D\u2026",
    "services.exposing": "\u516C\u5F00\u4E2D\u2026",
    "services.exposeDone": "\u5B8C\u6210",
    "services.exposeFailed": "\u516C\u5F00\u5931\u8D25",
    "services.providerChanged": "\u5DF2\u5207\u6362 provider",
    "services.title": "\u670D\u52A1\u7AEF\u53E3",
    "services.tabPorts": "\u7AEF\u53E3",
    "services.tabUsers": "\u7528\u6237",
    "services.tabSelf": "Pi-web",
    "services.selfAccessUrls": "\u53EF\u8BBF\u95EE\u5730\u5740",
    "services.selfUrl.loopback": "\u672C\u673A\uFF08\u56DE\u73AF\uFF09",
    "services.selfUrl.lan": "\u5C40\u57DF\u7F51\uFF08{name}\uFF09",
    "services.selfUrl.vhostLocal": "\u670D\u52A1\u865A\u62DF\u4E3B\u673A\uFF08\u672C\u673A\uFF09",
    "services.selfUrl.vhostBase": "\u670D\u52A1\u865A\u62DF\u4E3B\u673A\uFF08\u90E8\u7F72\u57DF\uFF09",
    "services.selfUrl.tunnel": "\u96A7\u9053\u516C\u7F51",
    "services.selfUrl.allowhost": "\u4F8B\u5916\u57DF\u540D\uFF08allowHost\uFF09",
    "services.selfExpose": "\u66B4\u9732 pi-web \u81EA\u8EAB",
    "services.selfExposeUrls": "\u5DF2\u66B4\u9732\u5730\u5740\uFF08\u8BA4\u8BC1\u5165\u53E3\uFF09:",
    "services.selfExposeHint": "\u5F00\u542F\u4E00\u4E2A\u5E26\u8BA4\u8BC1\u7684\u516C\u7F51\u5165\u53E3\uFF08portal/basic/authelia\uFF09\u3002\u5916\u90E8\u7528\u6237\u53EA\u80FD\u901A\u8FC7\u8BE5\u7F51\u5173\u8BBF\u95EE pi-web\uFF1B\u76F4\u8FDE 127/\u5C40\u57DF\u7F51\u7531\u4E0B\u65B9 allowlocal \u5F00\u5173\u63A7\u5236\u3002",
    "services.selfExposing": "\u5DF2\u66B4\u9732",
    "services.selfNotExposing": "\u672A\u66B4\u9732",
    "services.selfMode": "\u6A21\u5F0F",
    "services.selfAuth": "\u8BA4\u8BC1",
    "services.selfTunnel": "\u96A7\u9053",
    "services.selfExposeBtn": "\u66B4\u9732",
    "services.selfStopTunnel": "\u505C\u6B62",
    "services.selfStopTunnelHint": "\u4EC5\u505C\u6B62\u8BE5\u96A7\u9053\u6E20\u9053\uFF08\u865A\u62DF\u4E3B\u673A\u5165\u53E3\u4FDD\u7559\uFF09",
    "services.selfStopVhostHint": "\u505C\u6B62\u8BE5\u865A\u62DF\u4E3B\u673A\u901A\u9053\uFF08\u79FB\u9664 binding\uFF0C\u96A7\u9053\u5165\u53E3\u4FDD\u7559\uFF09",
    "services.selfAllowLocal": "\u5141\u8BB8\u672C\u5730\u76F4\u8FDE\uFF08allowlocal\uFF09",
    "services.selfAllowLocalHint": "\u5173\u95ED\u540E\uFF0C\u5C40\u57DF\u7F51/\u516C\u7F51/\u56DE\u73AF\u76F4\u8FDE\u672C\u7AEF\u53E3\u4E00\u5F8B 403\u2014\u2014\u53EA\u6709\u7ECF\u8FC7\u8BA4\u8BC1\u7684\u7F51\u5173\u53EF\u7528\uFF1A\u865A\u62DF\u4E3B\u673A\u57DF\u540D\u4E0E\u81EA\u66B4\u9732\u96A7\u9053\u57DF\u540D\u90FD\u4F1A\u8D70 proxy \u8BA4\u8BC1\uFF1B\u56DE\u73AF\uFF08127.0.0.1/localhost\uFF09\u540C\u6837\u53D7\u5F71\u54CD\uFF08\u4EC5\u4F8B\u5916\u57DF\u540D\u4E0E\u81EA\u66B4\u9732\u7684\u7F51\u5173\u8BA4\u8BC1\u8F6C\u53D1\u53EF\u5165\uFF09\u3002",
    "services.selfAllowHosts": "\u4F8B\u5916\u57DF\u540D\uFF08allowHost\uFF09",
    "services.selfAllowHostsHint": "allowlocal=false \u65F6\u4ECD\u5141\u8BB8\u76F4\u8FDE\u7684\u57DF\u540D\u2014\u2014\u4F60\u81EA\u5DF1\u9632\u62A4\u5C42\uFF08\u53CD\u5411\u4EE3\u7406\uFF09\u8F6C\u53D1\u7684\u5165\u53E3\u3002\u53EA\u8BA4\u4F60\u663E\u5F0F\u5217\u51FA\u7684\u57DF\u540D\uFF08\u90E8\u7F72\u57DF\u4E0D\u4F1A\u81EA\u52A8\u653E\u884C\uFF1A\u88F8\u90E8\u7F72\u57DF\u8981\u4E48\u8D70 proxy \u8BA4\u8BC1\uFF0C\u8981\u4E48\u663E\u5F0F\u5217\u5728\u8FD9\u91CC\uFF09\u3002",
    "services.selfAllowHostsCurrent": "\u5F53\u524D\u5141\u8BB8",
    "services.selfAllowHostsSave": "\u4FDD\u5B58",
    "services.selfGatedHint": "allowlocal=false\uFF1A\u76F4\u8FDE\u88AB\u62D2\u7EDD\uFF08403\uFF09\uFF0C\u8BF7\u8D70\u865A\u62DF\u4E3B\u673A/\u96A7\u9053\u8BA4\u8BC1\u5165\u53E3",
    "services.selfNotExposingHint": "\u5F53\u524D\u672A\u66B4\u9732 pi-web\uFF1Aallowlocal=false \u65F6\u672C\u7AEF\u53E3\u76F4\u8FDE\uFF08\u542B\u56DE\u73AF\uFF09\u4E00\u5F8B 403\u2014\u2014\u5148\u901A\u8FC7\u4E0B\u65B9\u66B4\u9732\u65B9\u6CD5\uFF08\u865A\u62DF\u4E3B\u673A/\u96A7\u9053\uFF09\u5F00\u542F\u5165\u53E3\uFF0C\u5916\u90E8\u8BBF\u95EE\u624D\u53EF\u8FBE\u3002",
    "services.lockoutTitle": "allowlocal \u5DF2\u4E34\u65F6\u5173\u95ED\uFF08{ttl} \u79D2\u5185\u81EA\u52A8\u6062\u590D\uFF09",
    "services.lockoutCountdown": "\u672C\u5730\u76F4\u8FDE\u5DF2\u4E34\u65F6\u5173\u95ED\uFF0C{ttl} \u79D2\u5185\u81EA\u52A8\u6062\u590D\u3002\u8BF7\u786E\u8BA4\u4F60\u4ECD\u80FD\u8BBF\u95EE pi-web\uFF08\u53EF\u6253\u5F00\u4E0B\u65B9\u5165\u53E3\u9A8C\u8BC1\u767B\u5F55\uFF09\uFF0C\u5E76\u5728 {window} \u79D2\u5185\u70B9\u51FB\u300C\u786E\u8BA4\u5173\u95ED\u300D\u6C38\u4E45\u751F\u6548\u2014\u2014\u5426\u5219\u81EA\u52A8\u56DE\u9000\uFF0C\u4E0D\u4F1A\u9501\u6B7B\u3002",
    "services.lockoutAutoRestore": "\u4E0D\u505A\u4EFB\u4F55\u64CD\u4F5C \u2192 allowlocal \u81EA\u52A8\u6062\u590D\uFF08\u4E0D\u4F1A\u88AB\u9501\uFF09\u3002",
    "services.lockoutBlockedHint": "\u76F4\u8FDE\u5DF2\u88AB\u5C4F\u853D\uFF08403\uFF09\uFF1A\u8BE5\u64CD\u4F5C\u9700\u901A\u8FC7\u8BA4\u8BC1\u5165\u53E3\uFF08\u865A\u62DF\u4E3B\u673A/\u96A7\u9053\uFF09\u8BBF\u95EE\u624D\u80FD\u5B8C\u6210\u3002\u7B49\u5F85\u81EA\u52A8\u6062\u590D\uFF08\u7EA6 {ttl}s\uFF09\uFF0C\u6216\u4F7F\u7528\u4E0B\u9762\u53EF\u7528\u7684\u8BBF\u95EE\u65B9\u5F0F\u3002",
    "services.lockoutStillWorks": "\u5173\u95ED\u671F\u95F4\u4ECD\u53EF\u8BBF\u95EE\uFF1A",
    "services.lockoutVerify": "\u6253\u5F00\u5E76\u9A8C\u8BC1\u767B\u5F55",
    "services.lockoutRestore": "\u7ACB\u5373\u6062\u590D",
    "services.lockoutConfirm": "\u786E\u8BA4\u5173\u95ED\uFF08\u4FDD\u7559\uFF09",
    "services.lockoutNoEntryTitle": "\u65E0\u6CD5\u5173\u95ED\u672C\u5730\u76F4\u8FDE",
    "services.lockoutNoEntry": "\u5F53\u524D\u6CA1\u6709\u4EFB\u4F55\u5173\u95ED\u540E\u4ECD\u53EF\u8BBF\u95EE\u7684\u5165\u53E3\uFF1Api-web \u672A\u66B4\u9732\uFF08\u65E0\u865A\u62DF\u4E3B\u673A/\u96A7\u9053\uFF09\uFF0C\u4E5F\u672A\u914D\u7F6E\u4F8B\u5916\u57DF\u540D\uFF08allowHost\uFF09\u3002\u5173\u95ED\u540E\u5C06\u65E0\u6CD5\u8BBF\u95EE\u3002\u8BF7\u5148\u66B4\u9732 pi-web\uFF08\u865A\u62DF\u4E3B\u673A/\u96A7\u9053\u8BA4\u8BC1\u5165\u53E3\uFF09\u6216\u6DFB\u52A0\u4F8B\u5916\u57DF\u540D\u3002",
    "services.lockoutRestored": "allowlocal \u5DF2\u6062\u590D\uFF08true\uFF09\uFF0C\u76F4\u8FDE\u53EF\u7528",
    "services.copy": "\u590D\u5236",
    "services.selfEnvHint": "\u6C38\u4E45\u914D\u7F6E\uFF08\u590D\u5236\u5230\u542F\u52A8\u811A\u672C\uFF09\uFF1A",
    "services.selfEnvNote": "\u754C\u9762\u6539\u52A8\u4E00\u6B21\u6027\u751F\u6548\uFF0C\u91CD\u542F\u6062\u590D\u73AF\u5883\u53D8\u91CF\u503C\u3002\u5982\u9700\u6301\u4E45\u5316\u8BF7\u8BBE\u7F6E PI_WEB_EXPOSE\u3002",
    "services.selfWarning": "pi-web \u6B63\u5728\u66B4\u9732\u4E14\u53EF\u4ECE\u975E\u56DE\u73AF\u5730\u5740\u8BBF\u95EE\u2014\u2014\u5C40\u57DF\u7F51\u76F4\u8FDE\u4F1A\u7ED5\u8FC7\u7F51\u5173\u8BA4\u8BC1\u3002\u5EFA\u8BAE\u4EC5\u76D1\u542C 127.0.0.1 \u6216\u542F\u7528\u5BC6\u7801\u3002",
    "services.selfNoAuth": "\u81EA\u66B4\u9732\u672A\u542F\u7528\u8BA4\u8BC1",
    "services.selfNoAuthSummary": "\u4EFB\u4F55\u62FF\u5230\u5730\u5740\u7684\u4EBA\u90FD\u80FD\u5B8C\u5168\u63A7\u5236 pi-web\uFF08\u6267\u884C\u547D\u4EE4\u3001\u8BFB\u5199\u6587\u4EF6\uFF09\uFF0C\u5B58\u5728\u6570\u636E\u6CC4\u9732\u98CE\u9669",
    "services.selfNoAuthReason": "\u67E5\u770B\u539F\u56E0",
    "services.selfNoAuthBody": "pi-web \u627F\u8F7D agent \u4F1A\u8BDD\uFF0C\u53EF\u6267\u884C\u4EFB\u610F\u547D\u4EE4\u3001\u8BFB\u5199\u7528\u6237\u6587\u4EF6\u3002\u5F53\u524D\u81EA\u66B4\u9732\uFF08expose self\uFF09\u672A\u542F\u7528\u4EFB\u4F55\u7F51\u5173\u8BA4\u8BC1\uFF08auth=none\uFF09\uFF1A\u4EFB\u4F55\u62FF\u5230\u5730\u5740\u7684\u4EBA\u90FD\u80FD\u5B8C\u5168\u63A7\u5236 pi-web\u3002\u5373\u4F7F allowlocal \u5173\u95ED\uFF0C\u5F00\u653E\u7684\u865A\u62DF\u4E3B\u673A/\u96A7\u9053\u5165\u53E3\u4F9D\u7136\u53EF\u7ECF\u90E8\u7F72\u57DF\u8BBF\u95EE\u3002",
    "services.selfNoAuthSuggest": "\u6362\u6210\u5E26\u8BA4\u8BC1\u7684\u66B4\u9732\u65B9\u6CD5\uFF1A\u5728\u300C\u670D\u52A1 \u2192 \u66B4\u9732 pi-web \u81EA\u8EAB\u300D\u628A\u8BA4\u8BC1\u4ECE none \u6539\u4E3A portal / basic\uFF08\u6216 authelia\uFF09\uFF0C\u5E76\u786E\u4FDD\u8BE5\u7AD9\u70B9\u4E0B\u6709\u53EF\u767B\u5F55\u7528\u6237\uFF08\u53EF\u5F00\u542F 2FA\uFF09\\n\u6216\u628A\u6A21\u5F0F\u6539\u4E3A\u4EC5 proxy\uFF08\u672C\u5730\u865A\u62DF\u4E3B\u673A\uFF0C\u53D7 allowlocal / \u5BC6\u7801\u95E8\u7981\u7EA6\u675F\uFF09\uFF0C\u4E0D\u5F00\u542F\u96A7\u9053\\n\u6216\u7ACB\u5373\u505C\u6B62\u66B4\u9732\uFF0C\u4E4B\u540E\u518D\u91CD\u65B0\u914D\u7F6E",
    "services.selfNoAuthOpen": "\u53BB\u66F4\u6362\u66B4\u9732\u65B9\u5F0F",
    "services.selfNoAuthStop": "\u7ACB\u5373\u505C\u6B62\u66B4\u9732",
    "services.selfNoAuthDismiss": "\u672C\u6B21\u4F1A\u8BDD\u4E0D\u518D\u63D0\u793A",
    "services.auto": "\u6BCF 10 \u79D2\u81EA\u52A8\u5237\u65B0",
    "services.autoOff": "\u81EA\u52A8\u5237\u65B0\u5DF2\u5173\u95ED",
    "services.loading": "\u626B\u63CF\u4E2D...",
    "services.none": "\u6CA1\u6709\u53D1\u73B0\u670D\u52A1\u7AEF\u53E3\u3002pi \u4F1A\u8BDD\u542F\u52A8\u7684\u670D\u52A1\u4F1A\u81EA\u52A8\u51FA\u73B0\u5728\u8FD9\u91CC\u3002",
    "services.open": "\u6253\u5F00",
    "services.refresh": "\u5237\u65B0",
    "services.ngrokAuthtoken": "ngrok authtoken",
    "services.ngrokAuthtokenPlaceholder": "\u7C98\u8D34 NGROK_AUTHTOKEN\uFF08\u5FC5\u586B\uFF09",
    "services.ngrokAuthtokenGet": "\u83B7\u53D6 token",
    "services.error": "\u626B\u63CF\u670D\u52A1\u7AEF\u53E3\u5931\u8D25",
    "services.close": "\u5173\u95ED",
    "services.direct": "\u76F4\u8FDE\uFF08\u7ED5\u8FC7 pi-web\uFF09",
    "services.viaProxy": "\u901A\u8FC7 pi-web \u865A\u62DF\u4E3B\u673A",
    "services.proxyLocal": "\u672C\u5730\u4EE3\u7406",
    "services.proxyDomain": "\u57DF\u540D",
    "services.proxyDeploy": "\u90E8\u7F72\u5165\u53E3",
    "services.listenOn": "\u76D1\u542C",
    "services.sameMachine": "\u672C\u673A",
    "services.currentDomain": "\u5F53\u524D\u57DF\u540D",
    "services.infoAccess": "\u5982\u4F55\u8BA9\u5176\u4ED6\u8BBE\u5907\u8BBF\u95EE\uFF08DNS / \u6CDB\u57DF\u540D\uFF09",
    "services.infoAuth": "\u8BA4\u8BC1\u8BF4\u660E",
    "services.exposeLocal": "\u672C\u673A\uFF1A*.pi.localhost \u96F6\u914D\u7F6E\uFF08RFC 6761\uFF0C\u6D4F\u89C8\u5668\u81EA\u52A8\u6620\u5C04 127.0.0.1\uFF09\u3002",
    "services.exposeLan": "\u5C40\u57DF\u7F51\uFF1Adnsmasq \u52A0 address=/pi.lan/<\u670D\u52A1\u5668IP>\uFF0C\u5E76\u8BBE\u7F6E PI_WEB_SVC_HOST_SUFFIX=.pi.lan\u3001PI_WEB_ALLOWED_HOSTS=pi.lan\u3002",
    "services.exposePublic": "\u516C\u7F51\u57DF\u540D\uFF1ADNS \u52A0\u901A\u914D A \u8BB0\u5F55 *.pi.example.com \u2192 \u670D\u52A1\u5668IP\uFF0C\u57DF\u540D\u52A0\u5165 PI_WEB_ALLOWED_HOSTS\u3002",
    "services.exposeTunnel": "\u96A7\u9053\u53EA\u66B4\u9732\u5355\u4E2A\u670D\u52A1\u7AEF\u53E3\uFF08\u6216\u5176\u865A\u62DF\u4E3B\u673A\u5B50\u57DF\u540D\uFF09\u2014\u2014\u7EDD\u4E0D\u662F pi-web \u672C\u4F53\u3002\u5728\u670D\u52A1\u7AEF\u53E3\u5361\u7247\u7684\u300C\u516C\u7F51\u8BBF\u95EE\u300D\u533A\u9009\u62E9\u96A7\u9053\u7C7B\u578B + \u8BA4\u8BC1\u65B9\u5F0F\u5C31\u5730\u5F00\u542F\u3002\u5207\u52FF\u628A\u96A7\u9053\u6307\u5411 pi-web \u81EA\u8EAB\u7AEF\u53E3\uFF1A\u672A\u52A0\u5165\u767D\u540D\u5355\u4F1A\u88AB\u9632\u62A4\u62E6\u622A\uFF08403\uFF09\uFF0C\u52A0\u5165\u5219\u7B49\u4E8E\u65E0\u9632\u62A4\u66B4\u9732 pi-web\u3002",
    "services.tunnelStatus": "\u96A7\u9053",
    "services.tunnelRunning": "\u8FD0\u884C\u4E2D",
    "services.tunnelStopped": "\u5DF2\u505C\u6B62",
    "services.tunnelStart": "\u5F00\u542F",
    "services.tunnelStop": "\u505C\u6B62",
    "services.portTunnel": "\u5F00\u542F\u6B64\u7AEF\u53E3\u96A7\u9053\uFF08\u4EC5\u66B4\u9732\u8BE5\u7AEF\u53E3\uFF09",
    "services.activePortTunnels": "\u5DF2\u5F00\u542F\u7684\u7AEF\u53E3\u96A7\u9053",
    "services.activeExposes": "\u6D3B\u52A8\u66B4\u9732",
    "services.details": "\u8BE6\u60C5",
    "services.needsAuth": "\u9700 token",
    "services.needsAuthHint": "ngrok.com \u514D\u8D39\u6CE8\u518C\u540E\u6267\u884C\uFF1Angrok config add-authtoken <token>",
    "services.portTunnelHint": "\u53EA\u66B4\u9732\u8BE5\u7AEF\u53E3\u3002pi-web \u672C\u4F53\u672A\u7ECF\u8BA4\u8BC1\u9632\u62A4\u4E0D\u8981\u8D70\u96A7\u9053\u3002",
    "services.authHint": "\u5728\u66B4\u9732\u4EFB\u4F55\u670D\u52A1\u524D\uFF0C\u8BF7\u5148\u4E3A pi-web\uFF08\u6216\u96A7\u9053\uFF09\u914D\u7F6E HTTPS \u4E0E\u8BA4\u8BC1\u3002",
    "services.authBuiltinTitle": "\u5DF2\u5185\u7F6E\u652F\u6301\uFF08\u7AEF\u53E3\u5361\u7247\u300C\u7ACB\u5373\u516C\u5F00\u300D\u4E2D\u53EF\u76F4\u63A5\u9009\u7528\uFF09",
    "services.authBuiltinPortal": "portal \u2014\u2014 \u5185\u7F6E\u8BA4\u8BC1\u95E8\u6237\uFF1A\u81EA\u5E26\u7528\u6237\u7BA1\u7406\u4E0E TOTP 2FA\uFF0C\u53EF\u5728\u300C\u7528\u6237\u300D\u9875\u7B7E\u6DFB\u52A0/\u7BA1\u7406\u7528\u6237",
    "services.authBuiltinBasic": "basic \u2014\u2014 HTTP Basic \u8BA4\u8BC1\uFF1A\u7528\u6237\u540D + \u5BC6\u7801",
    "services.authBuiltinAuthelia": "authelia \u2014\u2014 \u63A5\u5165\u81EA\u6258\u7BA1 Authelia\uFF08forward_auth\uFF1BWindows \u5E73\u53F0\u4E0D\u53EF\u7528\uFF09",
    "services.authExtendTitle": "\u53EF\u81EA\u884C\u6269\u5C55\uFF08\u5728 pi-web / \u96A7\u9053\u524D\u7F6E\u7684 nginx \u6216 Caddy \u4E0A\u914D\u7F6E\uFF09",
    "services.authExtendList": "Authentik \u2014\u2014 \u5F00\u6E90\u8EAB\u4EFD\u5E73\u53F0\uFF08OIDC/SAML/LDAP\uFF09\\noauth2-proxy \u2014\u2014 \u8F7B\u91CF\u53CD\u5411\u4EE3\u7406\u8BA4\u8BC1\uFF0C\u5BF9\u63A5 Google/GitHub/OIDC\\nKeycloak \u2014\u2014 \u4F01\u4E1A\u7EA7 IAM\uFF08\u8F83\u91CD\uFF09\\nCloudflare Access \u2014\u2014 \u6258\u7BA1\u5F0F\u96F6\u4FE1\u4EFB\u7F51\u5173",
    "services.configCurrent": "\u5F53\u524D\u9875\u9762\u901A\u8FC7 {host} \u8BBF\u95EE\uFF0C\u5DF2\u81EA\u52A8\u652F\u6301 {host} \u865A\u62DF\u4E3B\u673A\uFF0C\u5730\u5740\u5F62\u5982 http://<\u7AEF\u53E3>{host}{pagePort}{basePath}\u3002"
  }
};

// client/src/host-shim.ts
var _ctx = null;
function __setCtx(ctx) {
  _ctx = ctx;
}
function c(name) {
  return _ctx?.[name] ?? (() => void 0);
}
var Fragment = typeof Symbol !== "undefined" && Symbol.for ? /* @__PURE__ */ Symbol.for("react.fragment") : 2763;
function createElement(...args) {
  return c("h").call(null, ...args);
}
function mergeKey(args) {
  const [type, props, key, ...rest] = args;
  if (key !== void 0 && key !== null && props && typeof props === "object") {
    return [type, { ...props, key }, ...rest];
  }
  return args;
}
var jsx = (...args) => createElement(...mergeKey(args));
var jsxs = (...args) => {
  const props = args[1];
  const children = props?.children;
  if (Array.isArray(children)) {
    for (const c2 of children) {
      if (c2 && typeof c2 === "object" && c2._store) {
        c2._store.validated = 1;
      }
    }
  }
  return createElement(...mergeKey(args));
};
var useState = (init) => c("useState")(init);
var useEffect = (fn, deps) => c("useEffect")(fn, deps);
var useRef = (v) => c("useRef")(v);
var useCallback = (fn, deps) => c("useCallback")(fn, deps);
function apiUrl(path) {
  return c("apiUrl")(path);
}
var BASE_PATH = (() => {
  try {
    const pathname = window.location.pathname;
    const seg = pathname.split("/")[1] ?? "";
    if (seg && !["api", "extensions", "_next", "sw.js", "manifest.webmanifest"].includes(seg)) {
      return "/" + seg;
    }
  } catch {
  }
  return "";
})();
function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}
function currentLocale() {
  try {
    const stored = window.localStorage.getItem("pi-locale");
    if (stored === "en" || stored === "zh-CN") return stored;
  } catch {
  }
  try {
    const lang = document.documentElement.lang || window.navigator.language;
    if (lang.toLowerCase().startsWith("zh")) return "zh-CN";
  } catch {
  }
  return "en";
}
function translate(key, params) {
  const table = I18N[currentLocale()] ?? I18N.en ?? {};
  let message = table[key];
  if (message === void 0 && currentLocale() !== "en") message = I18N.en?.[key];
  if (message === void 0) return key;
  if (params) {
    message = message.replace(/\{([\w.-]+)\}/g, (token, name) => {
      const value = params[name];
      return value === void 0 ? token : String(value);
    });
  }
  return message;
}
function useI18n() {
  return {
    locale: currentLocale(),
    setLocale: () => {
    },
    t: translate,
    supportedLocales: []
  };
}
function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 640px)");
    setMobile(mql.matches);
    const onChange = () => setMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return mobile;
}
function openFileInHost(filePath, fileName) {
  try {
    const openFile = _ctx?.openFile;
    if (typeof openFile === "function") {
      void openFile(filePath, fileName);
      return;
    }
    window.postMessage({ __dbg: 1, type: "aiti_open_file", payload: { filePath, fileName: fileName ?? filePath.split("/").pop() ?? filePath } }, "*");
  } catch {
  }
}

// client/src/face-capture.tsx
function FaceCaptureModal({ name, provider, site, t, mode = "enroll", onClose, onDone }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const mirroredRef = useRef(true);
  const streamRef = useRef(null);
  const stRef = useRef({ vectors: [], mouthCount: 0, prevClosed: false, baseline: [], posting: false, diag: { found: false, mar: 0, base: 0, err: "", hist: [] } });
  const [cams, setCams] = useState([]);
  const [camId, setCamId] = useState("");
  const [facing, setFacing] = useState("");
  const [progress, setProgress] = useState(0);
  const [diag, setDiag] = useState({ found: false, mar: 0, base: 0, err: "", hist: [] });
  const [camError, setCamError] = useState("");
  const [modelStatus, setModelStatus] = useState("loading");
  const [modelError, setModelError] = useState("");
  const [saving, setSaving] = useState(false);
  const target = mode === "verify" ? 1 : 3;
  useEffect(() => {
    let cancelled = false;
    const startCam = async () => {
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      setCamError("");
      try {
        const tryGum = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });
        let stream = null;
        let lastErr = null;
        try {
          stream = await tryGum(camId ? { deviceId: { exact: camId }, width: { ideal: 640 } } : { facingMode: "user", width: { ideal: 640 } });
        } catch (e) {
          lastErr = e;
          if (!camId) {
            try {
              stream = await tryGum({ width: { ideal: 640 } });
            } catch (e2) {
              lastErr = e2;
            }
          }
        }
        if (!stream) throw lastErr ?? new Error("no camera");
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = stream;
        const s = stream.getVideoTracks()[0]?.getSettings();
        const f = s?.facingMode === "environment" ? "environment" : "user";
        setFacing(f);
        mirroredRef.current = f === "user";
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => {
          });
        }
      } catch (e) {
        setCamError(t("services.bioFaceCamError") + String(e.message ?? e));
      }
    };
    startCam();
    navigator.mediaDevices.enumerateDevices().then((devs) => {
      const vids = devs.filter((d) => d.kind === "videoinput").map((d, i) => ({ id: d.deviceId, label: d.label || `${t("services.bioFaceCam")} ${i + 1}` }));
      setCams(vids);
      if (camId && !vids.some((d) => d.id === camId)) setCamId("");
    }).catch(() => {
    });
    return () => {
      cancelled = true;
    };
  }, [camId]);
  useEffect(() => {
    let cancelled = false;
    const st = stRef.current;
    const action = mode === "verify" ? "biometric-verify-face" : "biometric-enroll-face";
    const postResult = async () => {
      const res = await fetch(apiUrl("/api/extensions/service-tunnels/status"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name, provider, site, samples: st.vectors })
      }).then((r) => r.json());
      if (res.error) throw new Error(res.error);
      return res;
    };
    const loop = (faceapi) => {
      const tick = async () => {
        if (cancelled || st.posting) return;
        const v = videoRef.current;
        const cv = canvasRef.current;
        if (!v || !cv) {
          setTimeout(tick, 120);
          return;
        }
        try {
          if (v.readyState < 2 || !v.videoWidth) {
            setTimeout(tick, 120);
            return;
          }
          const det = await faceapi.detectSingleFace(v, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })).withFaceLandmarks().withFaceDescriptor();
          if (det) {
            let drawErr = "";
            try {
              draw(faceapi, cv, det, mirroredRef.current);
            } catch (e) {
              drawErr = String(e.message ?? e);
            }
            const mar = marOf(det.landmarks.getMouth());
            st.diag.found = true;
            st.diag.mar = mar;
            st.diag.err = drawErr;
            st.diag.hist.push(mar);
            if (st.diag.hist.length > 12) st.diag.hist.shift();
            st.baseline.push(mar);
            if (st.baseline.length > 30) st.baseline.shift();
            const sorted = [...st.baseline].sort((a, b) => a - b);
            const q = sorted[Math.floor(sorted.length * 0.3)] ?? 0.4;
            const base = Math.max(0.4, q + 0.15);
            st.diag.base = base;
            const closed = mar >= base;
            if (closed && !st.prevClosed) {
              st.mouthCount++;
              st.vectors.push(Array.from(det.descriptor));
              setProgress(st.mouthCount);
              if (st.mouthCount >= target) {
                st.posting = true;
                setSaving(true);
                try {
                  await postResult();
                  streamRef.current?.getTracks().forEach((tr) => tr.stop());
                  onDone();
                } catch (e) {
                  setCamError(String(e.message ?? e));
                  st.posting = false;
                  setSaving(false);
                }
                return;
              }
            }
            st.prevClosed = closed;
          } else {
            st.diag.found = false;
            const ctx = cv.getContext("2d");
            if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
          }
        } catch (e) {
          st.diag.err = String(e.message ?? e);
        }
        setTimeout(tick, 60);
      };
      tick();
    };
    const run = async () => {
      try {
        const ensureRes = await fetch(apiUrl("/api/extensions/service-tunnels/status"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "biometric-assets-ensure" })
        }).then((r) => r.json());
        if (ensureRes.error) throw new Error(ensureRes.error);
        const base = `${BASE_PATH}/api/extensions/service-tunnels/face-assets/`;
        await loadScript(base + "face-api.js");
        const faceapi = window.faceapi;
        if (!faceapi) throw new Error("face-api load failed");
        await faceapi.tf.ready();
        await faceapi.nets.tinyFaceDetector.loadFromUri(base + "models/");
        await faceapi.nets.faceLandmark68Net.loadFromUri(base + "models/");
        await faceapi.nets.faceRecognitionNet.loadFromUri(base + "models/");
        if (cancelled) return;
        setModelStatus("ready");
        loop(faceapi);
      } catch (e) {
        setModelStatus("error");
        setModelError(String(e.message ?? e));
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const iv = setInterval(() => {
      const d = stRef.current.diag;
      setDiag({ found: d.found, mar: d.mar, base: d.base, err: d.err, hist: [...d.hist] });
    }, 500);
    return () => clearInterval(iv);
  }, []);
  const mirrored = facing === "user";
  const errText = camError || modelError;
  return /* @__PURE__ */ jsx("div", { style: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1e4 }, onClick: onClose, children: /* @__PURE__ */ jsxs("div", { style: { background: "var(--bg-panel, #1c1c24)", borderRadius: 12, padding: 18, width: "min(92vw, 440px)" }, onClick: (e) => e.stopPropagation(), children: [
    /* @__PURE__ */ jsxs("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--text, #eee)", marginBottom: 8 }, children: [
      "\u{1F642} ",
      t("services.bioFaceCaptureTitle"),
      " \xB7 ",
      name
    ] }),
    /* @__PURE__ */ jsxs("div", { style: { position: "relative", borderRadius: 8, overflow: "hidden", background: "#000" }, children: [
      /* @__PURE__ */ jsx(
        "video",
        {
          ref: videoRef,
          autoPlay: true,
          muted: true,
          playsInline: true,
          style: {
            width: "100%",
            display: "block",
            aspectRatio: "4/3",
            objectFit: "cover",
            transform: mirrored ? "scaleX(-1)" : void 0
          }
        }
      ),
      /* @__PURE__ */ jsx(
        "canvas",
        {
          ref: canvasRef,
          style: { position: "absolute", inset: 0, width: "100%", height: "100%" }
        }
      ),
      modelStatus === "ready" && !camError && /* @__PURE__ */ jsx("div", { style: { position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,.55)", color: progress >= target ? "#4caf50" : "#ffd54f", fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 999 }, children: mode === "verify" ? t("services.bioFaceVerifyProgress", { n: progress }) : t("services.bioFaceProgress", { n: progress }) })
    ] }),
    cams.length > 1 && /* @__PURE__ */ jsxs("div", { style: { marginTop: 8, display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ jsxs("span", { style: { fontSize: 11, color: "var(--text-dim, #999)", whiteSpace: "nowrap" }, children: [
        t("services.bioFaceCam"),
        ":"
      ] }),
      /* @__PURE__ */ jsxs(
        "select",
        {
          value: camId,
          onChange: (e) => setCamId(e.target.value),
          style: { flex: 1, background: "var(--bg, #141419)", color: "var(--text, #eee)", border: "1px solid var(--border, #444)", borderRadius: 6, padding: "4px 8px", fontSize: 11 },
          children: [
            /* @__PURE__ */ jsx("option", { value: "", children: t("services.bioFaceCamAuto") }),
            cams.map((c2) => /* @__PURE__ */ jsx("option", { value: c2.id, children: c2.label }, c2.id))
          ]
        }
      )
    ] }),
    modelStatus === "ready" && !camError && !saving && /* @__PURE__ */ jsxs("div", { style: { fontSize: 10, fontFamily: "var(--font-mono, monospace)", color: diag.err ? "#ff8a80" : "var(--text-dim, #999)", marginTop: 6, lineHeight: 1.5 }, children: [
      diag.err ? `\u26A0 ${diag.err}` : `\u4EBA\u8138 ${diag.found ? "\u2713" : "\u2014"} \xB7 \u5634\u5F00\u5EA6 ${diag.mar ? diag.mar.toFixed(2) : "--"} \xB7 \u9608\u503C ${diag.base ? diag.base.toFixed(2) : "--"} \xB7 \u5F20\u5634 ${progress}/3`,
      !diag.err && diag.hist.length > 0 && /* @__PURE__ */ jsx("span", { style: { display: "inline-flex", gap: 2, marginLeft: 6, verticalAlign: "middle" }, children: diag.hist.map((h, i) => /* @__PURE__ */ jsx("span", { style: { width: 5, height: 12, borderRadius: 1, background: h >= (diag.base || 0.35) ? "#ff8a80" : "#4caf50", display: "inline-block" } }, i)) })
    ] }),
    /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: errText ? "#ff8a80" : "var(--text-dim, #999)", marginTop: 8, lineHeight: 1.6, whiteSpace: "pre-wrap" }, children: saving ? t("services.bioFaceSaving") : errText ? errText : modelStatus === "ready" ? t("services.bioFaceCaptureHint") : t("services.bioFacePreparing") }),
    /* @__PURE__ */ jsx("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 10 }, children: /* @__PURE__ */ jsx("button", { onClick: onClose, style: { padding: "5px 14px", background: "none", border: "1px solid var(--border, #444)", borderRadius: 6, color: "var(--text-muted, #aaa)", cursor: "pointer", fontSize: 11 }, children: t("services.close") }) })
  ] }) });
}
var loadedScripts = /* @__PURE__ */ new Map();
function loadScript(src) {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => {
        loadedScripts.delete(src);
        reject(new Error(`load failed: ${src}`));
      };
      document.head.appendChild(s);
    }));
  }
  return loadedScripts.get(src);
}
function draw(faceapi, cv, det, mirrored) {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const display = { width: cv.clientWidth, height: cv.clientHeight };
  faceapi.matchDimensions(cv, display);
  const resized = faceapi.resizeResults(det, display);
  if (mirrored && resized) {
    const W = display.width;
    const box = resized?.detection?.box;
    if (box && typeof box._x === "number") box._x = W - box._x - box._width;
    const pts = resized?.landmarks?.positions;
    if (pts && Array.isArray(pts)) {
      for (let i = 0; i < pts.length; i++) pts[i] = { x: W - pts[i].x, y: pts[i].y };
    }
  }
  ctx.clearRect(0, 0, cv.width, cv.height);
  faceapi.draw.drawDetections(cv, resized, { withScore: false });
  faceapi.draw.drawFaceLandmarks(cv, resized);
}
function marOf(pts) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return (d(pts[3], pts[11]) + d(pts[5], pts[9])) / (2 * d(pts[1], pts[7]));
}

// client/src/ServicesDialog.tsx
function formatAddrForUrl(addr) {
  return addr.includes(":") ? `[${addr}]` : addr;
}
function isLikelyIp(hostname) {
  if (hostname.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}
function NoAuthBadge({ t }) {
  return /* @__PURE__ */ jsxs(
    "span",
    {
      title: t("services.noAuthWarnHint"),
      style: { padding: "1px 7px", background: "rgba(248,113,113,0.15)", border: "1px solid rgba(248,113,113,0.45)", borderRadius: 4, color: "var(--danger, #f87171)", fontWeight: 600, flexShrink: 0, fontSize: 10 },
      children: [
        "\u26A0 ",
        t("services.exposeProviderNone")
      ]
    }
  );
}
function normInjectEntries(ports) {
  if (!Array.isArray(ports)) return [];
  return ports.map((e) => {
    if (typeof e === "number" && Number.isFinite(e) && e > 0) return { port: e };
    if (e && typeof e === "object" && Number.isFinite(Number(e.port))) {
      const port = Number(e.port);
      if (port <= 0 || port > 65535) return null;
      const raw = e;
      const bp0 = typeof raw.basePath === "string" ? raw.basePath : typeof raw.serviceBasePath === "string" ? raw.serviceBasePath : "";
      const bp = bp0.replace(/^\/+/, "").replace(/\/+$/, "");
      return { port, ...bp ? { basePath: "/" + bp } : {} };
    }
    return null;
  }).filter((e) => e !== null);
}
function normalizeVhostScheme(u) {
  if (!u || !u.startsWith("http://")) return u;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (loopback) return u;
    url.protocol = window.location.protocol;
    return url.toString();
  } catch {
    return u;
  }
}
function normalizeExposeUrls(ex) {
  return {
    ...ex,
    baseUrl: ex.baseUrl ? normalizeVhostScheme(ex.baseUrl) : ex.baseUrl,
    domainUrl: ex.domainUrl ? normalizeVhostScheme(ex.domainUrl) : ex.domainUrl,
    loginUrl: ex.loginUrl ? normalizeVhostScheme(ex.loginUrl) : ex.loginUrl
  };
}
function ServicesDialog({ onClose, onOpenFile, initialTab: initialTab2 = "ports" }) {
  const isMobile = useIsMobile();
  const { t, locale } = useI18n();
  const [data, setData] = useState(null);
  const [userManagers, setUserManagers] = useState([]);
  const [allowDownload, setAllowDownload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(/* @__PURE__ */ new Set());
  const [copiedKey, setCopiedKey] = useState(null);
  const [logsFor, setLogsFor] = useState(null);
  const [logsData, setLogsData] = useState(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [detailFor, setDetailFor] = useState(null);
  const [tab, setTab] = useState(initialTab2);
  const [self, setSelf] = useState(null);
  const [infoModal, setInfoModal] = useState(null);
  const [injectEntries, setInjectEntries] = useState(null);
  const [injectSources, setInjectSources] = useState([]);
  const refresh = useCallback((force = false) => {
    if (!force) setLoading(false);
    fetch(apiUrl(`/api/extensions/service-tunnels/services${force ? "?refresh=1" : ""}`)).then((r) => r.json()).then((d) => {
      setData((prev) => ({ ...prev ?? {}, ...d, exposes: prev?.exposes ?? [] }));
      setError(null);
    }).catch(() => setError(String(t("services.error")))).finally(() => setLoading(false));
    fetch(`${apiUrl("/api/extensions/service-tunnels/status")}?lang=${encodeURIComponent(locale)}`).then((r) => r.json()).then((d) => {
      if (d.exposes) {
        const ex = d.exposes.map(normalizeExposeUrls);
        setData((prev) => ({ ...prev ?? {}, exposes: ex, services: prev?.services ?? [] }));
      }
      if (d.userManagers) setUserManagers(d.userManagers);
      if (d.injectSources) setInjectSources(d.injectSources);
      if (typeof d.allowToolDownload === "boolean") setAllowDownload(d.allowToolDownload);
      if (d.toolStatus) {
        setData((prev) => ({ ...prev ?? {}, toolStatus: d.toolStatus, services: prev?.services ?? [] }));
      }
      if (d.self) {
        setSelf(d.self && { ...d.self, urls: (d.self.urls ?? []).map((u) => ({ ...u, url: normalizeVhostScheme(u.url) })) });
      }
    }).catch(() => {
    });
    fetch(apiUrl("/api/extensions/service-tunnels/enroll")).then((r) => r.ok ? r.json() : null).then((d) => {
      const entries = d ? normInjectEntries(d.ports) : null;
      setInjectEntries(entries);
    }).catch(() => {
      setInjectEntries((p) => p ?? null);
    });
  }, [t, locale]);
  useEffect(() => {
    refresh(true);
    if (!autoRefresh) return;
    const id = setInterval(() => refresh(), 1e4);
    return () => clearInterval(id);
  }, [refresh, autoRefresh]);
  const scheme = typeof window !== "undefined" ? window.location.protocol : "http:";
  const pagePort = typeof window !== "undefined" && window.location.port ? `:${window.location.port}` : "";
  const hostname = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";
  const suffixes = data?.serviceHostSuffixes ?? [".pi.localhost"];
  const currentDomainSuffix = hostname && !isLikelyIp(hostname) && hostname !== "localhost" ? `.${hostname}` : null;
  const directUrl = (port, addr) => `http://${formatAddrForUrl(addr)}:${port}/`;
  const openInNewTab = (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };
  const copy = (key, url) => {
    copyText(url).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => k === key ? null : k), 1500);
    }).catch(() => {
    });
  };
  const stopExpose = useCallback((name) => {
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tunnel-stop", name })
    }).then(() => {
      setData(
        (prev) => prev ? { ...prev, exposes: (prev.exposes ?? []).filter((e) => e.name !== name) } : prev
      );
      refresh(false);
    }).catch(() => {
    });
  }, [refresh]);
  const toggleInject = useCallback((port, on, basePath) => {
    const cur = injectEntries ?? [];
    const existing = cur.find((e) => e.port === port);
    const entry = { port, ...basePath !== void 0 ? basePath ? { basePath } : {} : existing?.basePath ? { basePath: existing.basePath } : {} };
    const next = on ? [...cur.filter((e) => e.port !== port), entry] : cur.filter((e) => e.port !== port);
    setInjectEntries(next);
    fetch(apiUrl("/api/extensions/service-tunnels/enroll"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port, ...on ? basePath !== void 0 ? { basePath } : {} : { remove: true } })
    }).then((r) => r.json()).then((d) => {
      if (d && Array.isArray(d.ports)) setInjectEntries(normInjectEntries(d.ports));
    }).catch(() => refresh(false));
  }, [injectEntries, refresh]);
  const toggleExpand = (port) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(port)) next.delete(port);
      else next.add(port);
      return next;
    });
  };
  return /* @__PURE__ */ jsx("div", { style: { position: "fixed", inset: 0, zIndex: 1e3, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ jsxs("div", { style: {
    width: isMobile ? "calc(100vw - 16px)" : 760,
    maxWidth: "calc(100vw - 16px)",
    height: isMobile ? "calc(100dvh - 16px)" : "min(620px, 82vh)",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
    overflow: "hidden"
  }, children: [
    /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }, children: [
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "baseline", gap: 10 }, children: [
        /* @__PURE__ */ jsx("span", { style: { fontSize: 14, fontWeight: 600, color: "var(--text)" }, children: t("services.title") }),
        /* @__PURE__ */ jsxs("label", { style: { display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-dim)", cursor: "pointer" }, children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "checkbox",
              checked: autoRefresh,
              onChange: (e) => setAutoRefresh(e.target.checked),
              style: { accentColor: "var(--accent)", cursor: "pointer", margin: 0 }
            }
          ),
          autoRefresh ? t("services.auto") : t("services.autoOff")
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 4 }, children: [
        /* @__PURE__ */ jsx("button", { onClick: () => refresh(true), disabled: loading, title: t("services.refresh"), "aria-label": t("services.refresh"), style: { background: "none", border: "none", color: "var(--text-muted)", cursor: loading ? "default" : "pointer", padding: 4, display: "flex" }, children: /* @__PURE__ */ jsxs("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", style: { animation: loading ? "spin 0.8s linear infinite" : void 0 }, children: [
          /* @__PURE__ */ jsx("path", { d: "M21 12a9 9 0 1 1-3-6.7L21 8" }),
          /* @__PURE__ */ jsx("path", { d: "M21 3v5h-5" })
        ] }) }),
        /* @__PURE__ */ jsx("button", { onClick: onClose, title: t("services.close"), "aria-label": t("services.close"), style: { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }, children: /* @__PURE__ */ jsxs("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", children: [
          /* @__PURE__ */ jsx("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
          /* @__PURE__ */ jsx("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
        ] }) })
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { style: { display: "flex", gap: 2, padding: "6px 14px 0", borderBottom: "1px solid var(--border)", flexShrink: 0 }, children: ["ports", "self", "users"].map((k) => /* @__PURE__ */ jsx(
      "button",
      {
        onClick: () => setTab(k),
        style: {
          padding: "6px 14px",
          background: "none",
          borderLeft: "none",
          borderRight: "none",
          borderTop: "none",
          borderBottom: tab === k ? "2px solid var(--accent)" : "2px solid transparent",
          color: tab === k ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: tab === k ? 600 : 400
        },
        children: k === "ports" ? t("services.tabPorts") : k === "self" ? t("services.tabSelf") : t("services.tabUsers")
      },
      k
    )) }),
    tab === "ports" && /* @__PURE__ */ jsxs(Fragment, { children: [
      allowDownload !== null && /* @__PURE__ */ jsxs("label", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 18px", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text)", cursor: "pointer", flexShrink: 0 }, title: t("services.allowToolDownloadHint"), children: [
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "checkbox",
            checked: allowDownload,
            onChange: (e) => {
              const next = e.target.checked;
              setAllowDownload(next);
              fetch(apiUrl("/api/extensions/service-tunnels/status"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "set-allow-tool-download", allowDownload: next })
              }).catch(() => setAllowDownload(!next));
            },
            style: { accentColor: "var(--accent)", cursor: "pointer" }
          }
        ),
        /* @__PURE__ */ jsx("span", { children: t("services.allowToolDownload") }),
        (data?.toolStatus ?? []).filter((x) => x.source === null).length > 0 && /* @__PURE__ */ jsxs("span", { style: { fontSize: 11, color: "var(--text-dim)" }, children: [
          "(",
          t("services.toolsMissing"),
          ": ",
          (data?.toolStatus ?? []).filter((x) => x.source === null).map((x) => x.name).join(", "),
          ")"
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { flex: 1, overflowY: "auto", padding: "10px 12px" }, children: [
        (data?.exposes ?? []).some((e) => e.running) && /* @__PURE__ */ jsxs("div", { style: { padding: "8px 10px", border: "1px solid var(--accent)", borderRadius: 8, background: "var(--bg-panel)", marginBottom: 10 }, children: [
          /* @__PURE__ */ jsx("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }, children: t("services.activeExposes") }),
          (data?.exposes ?? []).filter((e) => e.running).map((ex) => {
            const primaryUrl = [ex.url, ex.localUrl, ex.baseUrl, ex.domainUrl].find((x) => Boolean(x)) ?? "";
            return /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", flexWrap: "wrap", fontSize: 11 }, children: [
              /* @__PURE__ */ jsxs("span", { style: { fontFamily: "var(--font-mono)", color: "var(--text)", flexShrink: 0 }, children: [
                "127.0.0.1:",
                ex.port
              ] }),
              /* @__PURE__ */ jsx("span", { style: { padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-muted)", flexShrink: 0 }, children: (ex.name ?? "").startsWith("proxy:") ? "proxy" : ex.tunnelType ?? "?" }),
              /* @__PURE__ */ jsx("span", { style: { padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-dim)", flexShrink: 0 }, children: ex.protocol ?? "http" }),
              ex.provider ? /* @__PURE__ */ jsxs("span", { style: { padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-muted)", flexShrink: 0 }, children: [
                "auth: ",
                ex.provider
              ] }) : (
                /* auth=none → 无认证告警,标红 */
                /* @__PURE__ */ jsxs(
                  "span",
                  {
                    title: t("services.noAuthWarnHint"),
                    style: { padding: "1px 7px", background: "rgba(248,113,113,0.15)", border: "1px solid rgba(248,113,113,0.45)", borderRadius: 4, color: "var(--danger, #f87171)", fontWeight: 600, flexShrink: 0 },
                    children: [
                      "\u26A0 ",
                      t("services.exposeProviderNone")
                    ]
                  }
                )
              ),
              /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: ex.running ? "#16a34a" : "var(--text-dim)", flexShrink: 0 }, children: ex.running ? t("services.tunnelRunning") : t("services.tunnelStopped") }),
              /* @__PURE__ */ jsxs(
                "button",
                {
                  onClick: () => setDetailFor(ex),
                  title: t("services.exposeDetailHint"),
                  style: { flex: 1, minWidth: 120, textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                  children: [
                    primaryUrl || t("services.exposeDetail"),
                    " \u203A"
                  ]
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  onClick: () => stopExpose(ex.name),
                  title: t("services.exposeStopHint"),
                  style: { flexShrink: 0, padding: "3px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--danger, #f87171)", cursor: "pointer", fontSize: 11 },
                  children: t("services.exposeStop")
                }
              ),
              ex.accessLog && /* @__PURE__ */ jsx("button", { onClick: () => {
                setLogsFor(logsFor === ex.name ? null : ex.name);
                if (logsFor !== ex.name) {
                  setLogsLoading(true);
                  fetch(apiUrl(`/api/extensions/service-tunnels/status?logs=${encodeURIComponent(ex.name)}`)).then((r) => r.json()).then((d) => {
                    setLogsData({ access: d.access ?? "", error: d.error ?? "" });
                    setLogsLoading(false);
                  }).catch(() => {
                    setLogsLoading(false);
                    setLogsData({ access: "(failed to read logs)", error: "" });
                  });
                }
              }, style: { flexShrink: 0, padding: "3px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }, children: logsFor === ex.name ? t("services.exposeLogsHide") : t("services.exposeLogs") })
            ] }, ex.name);
          }),
          logsFor && logsData && /* @__PURE__ */ jsxs("div", { style: { marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 6 }, children: [
            /* @__PURE__ */ jsxs("div", { style: { fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }, children: [
              "access log",
              logsLoading ? " \u2026" : ""
            ] }),
            /* @__PURE__ */ jsx("pre", { style: { maxHeight: 120, overflow: "auto", margin: 0, padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, fontSize: 9, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text)" }, children: logsData.access || "(empty)" }),
            /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--text-muted)", margin: "6px 0 4px" }, children: "error log" }),
            /* @__PURE__ */ jsx("pre", { style: { maxHeight: 120, overflow: "auto", margin: 0, padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, fontSize: 9, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--danger, #f87171)" }, children: logsData.error || "(empty)" })
          ] })
        ] }),
        error ? /* @__PURE__ */ jsx("div", { style: { fontSize: 13, color: "var(--danger, #f87171)", padding: 12 }, children: error }) : loading && !data ? /* @__PURE__ */ jsx("div", { style: { fontSize: 13, color: "var(--text-dim)", padding: 12 }, children: t("services.loading") }) : !data || (data.services ?? []).length === 0 ? /* @__PURE__ */ jsx("div", { style: { fontSize: 13, color: "var(--text-dim)", padding: 20, textAlign: "center" }, children: t("services.none") }) : (data.services ?? []).map((s) => {
          const isOpen = expanded.has(s.port);
          const directUrls = s.addresses.map((addr) => ({ addr, url: directUrl(s.port, addr) }));
          const proxyExposes = (data?.exposes ?? []).filter((e) => e.port === s.port && (e.localUrl || e.baseUrl || e.domainUrl));
          const proxyUrls = proxyExposes.flatMap((e) => [
            ...e.localUrl ? [{ url: e.localUrl, label: e.site && e.site !== "default" ? e.site : t("services.proxyLocal"), ex: e }] : [],
            ...e.baseUrl ? [{ url: e.baseUrl, label: t("services.proxyDomain"), ex: e }] : [],
            ...e.domainUrl ? [{ url: e.domainUrl, label: t("services.proxyDomain"), ex: e }] : []
          ]);
          if (proxyExposes.length > 0 && currentDomainSuffix && !currentDomainSuffix.startsWith(".localhost") && currentDomainSuffix !== ".pi.localhost") {
            proxyUrls.push({ url: `${scheme}//${s.port}${currentDomainSuffix}${pagePort}${BASE_PATH}`, label: t("services.proxyDeploy"), ex: proxyExposes[0] });
          }
          const seenUrls = /* @__PURE__ */ new Set();
          for (let ui = proxyUrls.length - 1; ui >= 0; ui--) {
            const pu = proxyUrls[ui];
            if (seenUrls.has(pu.url)) {
              proxyUrls.splice(ui, 1);
              continue;
            }
            seenUrls.add(pu.url);
          }
          const primaryUrl = proxyUrls[0]?.url ?? directUrls[0]?.url ?? "";
          return /* @__PURE__ */ jsxs("div", { id: `port-card-${s.port}`, style: { marginBottom: 6, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }, children: [
            /* @__PURE__ */ jsxs(
              "div",
              {
                onClick: () => toggleExpand(s.port),
                role: "button",
                tabIndex: 0,
                "aria-expanded": isOpen,
                onKeyDown: (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleExpand(s.port);
                  }
                },
                style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", cursor: "pointer", background: isOpen ? "var(--bg-panel)" : "none" },
                onMouseEnter: (e) => {
                  if (!isOpen) e.currentTarget.style.background = "var(--bg-hover)";
                },
                onMouseLeave: (e) => {
                  if (!isOpen) e.currentTarget.style.background = "none";
                },
                children: [
                  /* @__PURE__ */ jsx("span", { style: { fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--accent)", minWidth: 52 }, children: s.port }),
                  /* @__PURE__ */ jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [
                    /* @__PURE__ */ jsx("div", { style: { fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: s.cmdline || s.process || `pid ${s.pid}` }),
                    /* @__PURE__ */ jsxs("div", { style: { fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: [
                      t("services.listenOn"),
                      " ",
                      s.addresses.join(", "),
                      " \xB7 pid ",
                      s.pid
                    ] })
                  ] }),
                  /* @__PURE__ */ jsx(
                    "svg",
                    {
                      width: "12",
                      height: "12",
                      viewBox: "0 0 24 24",
                      fill: "none",
                      stroke: "currentColor",
                      strokeWidth: "2",
                      strokeLinecap: "round",
                      strokeLinejoin: "round",
                      style: { flexShrink: 0, color: "var(--text-dim)", transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" },
                      children: /* @__PURE__ */ jsx("polyline", { points: "6 9 12 15 18 9" })
                    }
                  )
                ]
              }
            ),
            isOpen && /* @__PURE__ */ jsxs("div", { style: { borderTop: "1px solid var(--border)", padding: "10px 12px", background: "var(--bg-panel)" }, children: [
              directUrls.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [
                /* @__PURE__ */ jsx("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "4px 0 6px" }, children: t("services.direct") }),
                directUrls.map(({ addr, url }) => /* @__PURE__ */ jsx(
                  UrlRow,
                  {
                    url,
                    label: addr === "127.0.0.1" || addr === "::1" ? "localhost" : addr,
                    isMobile,
                    copied: copiedKey === url,
                    onCopy: () => copy(url, url),
                    onOpen: () => openInNewTab(url)
                  },
                  url
                ))
              ] }),
              proxyUrls.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [
                /* @__PURE__ */ jsx("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "10px 0 6px" }, children: t("services.viaProxy") }),
                proxyUrls.map(({ url, label, ex }) => /* @__PURE__ */ jsx(
                  UrlRow,
                  {
                    url,
                    isMobile,
                    label,
                    copied: copiedKey === url,
                    onCopy: () => copy(url, url),
                    onOpen: () => setDetailFor(ex)
                  },
                  url
                ))
              ] }),
              /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 10 }, children: [
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    onClick: () => proxyUrls[0]?.ex ? setDetailFor(proxyUrls[0].ex) : openInNewTab(primaryUrl),
                    style: { padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, flexShrink: 0 },
                    children: t("services.open")
                  }
                ),
                /* @__PURE__ */ jsx("span", { style: { fontSize: 11, color: "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: primaryUrl })
              ] }),
              /* @__PURE__ */ jsx(
                AuthExposeSection,
                {
                  port: s.port,
                  t,
                  openInNewTab,
                  exposes: (data?.exposes ?? []).filter((e) => e.port === s.port),
                  serviceBasePath: injectEntries?.find((e) => e.port === s.port)?.basePath,
                  onSetBasePath: (p, bp) => toggleInject(p, true, bp),
                  injectSources,
                  onStopExpose: stopExpose,
                  onChanged: () => refresh(false),
                  onGoManageUsers: () => setTab("users")
                }
              )
            ] })
          ] }, s.port);
        }),
        (injectEntries ?? []).filter((e) => !(data?.services ?? []).some((s) => s.port === e.port) && e.port !== self?.port).map((e) => {
          const vhostUrl = currentDomainSuffix ? `${scheme}//${e.port}${currentDomainSuffix}${pagePort}${e.basePath ?? BASE_PATH}` : `http://${e.port}${suffixes[0] ?? ".pi.localhost"}${e.basePath ?? ""}`;
          return /* @__PURE__ */ jsx("div", { style: { marginBottom: 6, border: "1px dashed var(--border)", borderRadius: 8, overflow: "hidden" }, children: /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 10px" }, children: [
            /* @__PURE__ */ jsx("span", { style: { fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--accent)", minWidth: 52, flexShrink: 0 }, children: e.port }),
            /* @__PURE__ */ jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [
              /* @__PURE__ */ jsxs("div", { style: { fontSize: 12, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }, children: [
                /* @__PURE__ */ jsxs("span", { title: t("services.enrolledExtHint"), style: { padding: "0 5px", background: "var(--bg-hover)", borderRadius: 4, fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }, children: [
                  "\u{1F50C} ",
                  t("services.enrolledExtNotTree")
                ] }),
                e.basePath && /* @__PURE__ */ jsxs("span", { title: t("services.enrolledBasePathHint"), style: { padding: "0 5px", background: "var(--bg-hover)", borderRadius: 4, fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }, children: [
                  "base ",
                  e.basePath
                ] })
              ] }),
              /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: vhostUrl })
            ] }),
            /* @__PURE__ */ jsx("button", { onClick: () => openInNewTab(vhostUrl), title: vhostUrl, style: { flexShrink: 0, padding: "4px 12px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600 }, children: t("services.open") }),
            /* @__PURE__ */ jsx(
              "button",
              {
                onClick: () => toggleInject(e.port, false),
                title: t("services.enrolledUnenrollHint"),
                style: { flexShrink: 0, padding: "4px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--danger, #f87171)", cursor: "pointer", fontSize: 11 },
                children: t("services.enrolledUnenroll")
              }
            )
          ] }) }, `ext-${e.port}`);
        })
      ] }),
      /* @__PURE__ */ jsx("div", { style: { padding: "8px 14px 10px", borderTop: "1px solid var(--border)", flexShrink: 0, background: "var(--bg-panel)", maxHeight: "34%", overflowY: "auto" }, children: /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 16, padding: "4px 0", flexWrap: "wrap" }, children: [
        /* @__PURE__ */ jsxs(
          "button",
          {
            onClick: () => setInfoModal("access"),
            style: { background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)", fontSize: 11, textAlign: "left" },
            children: [
              t("services.infoAccess"),
              " \u203A"
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "button",
          {
            onClick: () => setInfoModal("auth"),
            style: { background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)", fontSize: 11, textAlign: "left" },
            children: [
              (data?.exposes ?? []).length > 0 ? "\u26A0 " : "\u{1F512} ",
              t("services.infoAuth"),
              " \u203A"
            ]
          }
        )
      ] }) })
    ] }),
    tab === "self" && /* @__PURE__ */ jsx("div", { style: { flex: 1, overflowY: "auto", padding: "12px 14px" }, children: /* @__PURE__ */ jsx(
      SelfTab,
      {
        self,
        t,
        openInNewTab,
        copy,
        copiedKey,
        onChanged: refresh,
        onGoManageUsers: () => setTab("users"),
        exposes: data?.exposes ?? [],
        onShowDetail: setDetailFor,
        onStopExpose: stopExpose,
        injectSources
      }
    ) }),
    tab === "users" && /* @__PURE__ */ jsx("div", { style: { flex: 1, overflowY: "auto", padding: "12px 14px" }, children: /* @__PURE__ */ jsx(AuthUsersSection, { t, isMobile }) }),
    infoModal && /* @__PURE__ */ jsx(
      InfoModal,
      {
        kind: infoModal,
        t,
        currentDomainSuffix,
        pagePort,
        basePath: BASE_PATH,
        onClose: () => setInfoModal(null)
      }
    ),
    detailFor && /* @__PURE__ */ jsx(
      ExposeDetailModal,
      {
        ex: detailFor,
        t,
        onClose: () => setDetailFor(null),
        onOpen: openInNewTab,
        onCopy: copy,
        copiedKey,
        onStop: () => {
          stopExpose(detailFor.name);
          setDetailFor(null);
        },
        onOpenFile,
        userManagers
      }
    )
  ] }) });
}
function providerDisplayLabel(p, t, authMetas) {
  if (p === "none") return t("services.exposeProviderNone");
  const k = `services.provider.${p}`;
  const tr = t(k);
  if (tr !== k) return tr;
  return authMetas?.[p]?.label ?? p;
}
function BooleanToggle({ spec, value, onChange, t }) {
  const on = value === void 0 ? Boolean(spec.default) : value === "true";
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      onClick: () => onChange(on ? "false" : "true"),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: on ? "#16a34a" : "var(--bg)",
        color: on ? "#fff" : "var(--text-muted)",
        fontSize: 11,
        cursor: "pointer",
        lineHeight: 1.4
      },
      children: [
        /* @__PURE__ */ jsx("span", { style: { width: 13, height: 13, borderRadius: 7, background: on ? "#fff" : "#8a8a8a", display: "inline-block", flexShrink: 0 } }),
        on ? t("services.on") : t("services.off")
      ]
    }
  );
}
function SchemaForm({ specs, values, onChange, t }) {
  if (!specs.length) return null;
  const inputStyle = {
    width: "100%",
    padding: "3px 6px",
    border: "1px solid var(--border)",
    borderRadius: 5,
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 11,
    fontFamily: "var(--font-mono)"
  };
  return /* @__PURE__ */ jsx("div", { style: { marginTop: 6 }, children: specs.map((s) => {
    const fixed = s.fixed === true;
    return /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsxs("label", { style: { fontSize: 10, color: "var(--text-muted)", display: "block", marginTop: 5 }, children: [
        s.label ?? s.key,
        s.required ? " *" : "",
        fixed ? " \u{1F512}" : "",
        s.link && /* @__PURE__ */ jsx("a", { href: s.link, target: "_blank", rel: "noreferrer", style: { color: "var(--accent)", marginLeft: 6, fontSize: 9 }, children: s.linkTitle ?? t("services.docs") })
      ] }),
      fixed ? /* @__PURE__ */ jsx(
        "input",
        {
          type: "text",
          value: String(s.value ?? s.default ?? ""),
          disabled: true,
          title: t("services.fixedParamHint"),
          style: { ...inputStyle, opacity: 0.75, cursor: "not-allowed" }
        }
      ) : s.type === "boolean" ? /* @__PURE__ */ jsx(
        BooleanToggle,
        {
          spec: s,
          value: values[s.key],
          onChange: (v) => onChange(s.key, v),
          t
        }
      ) : s.options ? /* @__PURE__ */ jsx(
        "select",
        {
          value: values[s.key] ?? String(s.default ?? ""),
          onChange: (e) => onChange(s.key, e.target.value),
          style: inputStyle,
          children: s.options.map((o) => /* @__PURE__ */ jsx("option", { value: o.value, children: o.label ?? o.value }, o.value))
        }
      ) : /* @__PURE__ */ jsx(
        "input",
        {
          type: s.type === "password" ? "password" : s.type === "number" ? "number" : "text",
          value: values[s.key] ?? String(s.default ?? ""),
          placeholder: s.placeholder,
          onChange: (e) => onChange(s.key, e.target.value),
          style: inputStyle
        }
      ),
      s.description && /* @__PURE__ */ jsx("div", { style: { fontSize: 9, color: "var(--text-dim)", marginTop: 1 }, children: s.description })
    ] }, s.key);
  }) });
}
function ExposeDetailModal({ ex, t, onClose, onOpen, onCopy, copiedKey, onStop, onOpenFile, userManagers = [] }) {
  const isMobile = useIsMobile();
  const links = [ex.url, ex.localUrl, ex.baseUrl, ex.domainUrl, ex.loginUrl].filter((u) => Boolean(u));
  const mode = (ex.name ?? "").startsWith("proxy:") ? "proxy" : ex.localUrl !== void 0 ? "both" : "tunnel";
  const startedAt = typeof ex.startedAt === "number" ? new Date(ex.startedAt) : null;
  const params = ex.params ?? null;
  const field = (label, value) => /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--border)" }, children: [
    /* @__PURE__ */ jsx("span", { style: { flexShrink: 0, width: 68, color: "var(--text-dim)", fontSize: 11, paddingTop: 2 }, children: label }),
    /* @__PURE__ */ jsx("span", { style: { flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", overflowWrap: "anywhere" }, children: value })
  ] });
  return /* @__PURE__ */ jsx("div", { style: { position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }, onClick: onClose, children: /* @__PURE__ */ jsxs("div", { onClick: (e) => e.stopPropagation(), style: { width: isMobile ? "calc(100vw - 32px)" : 520, maxWidth: "calc(100vw - 32px)", maxHeight: "min(620px, 82vh)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }, children: [
    /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }, children: [
      /* @__PURE__ */ jsxs("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--text)" }, children: [
        /* @__PURE__ */ jsxs("span", { style: { fontFamily: "var(--font-mono)" }, children: [
          "127.0.0.1:",
          ex.port
        ] }),
        /* @__PURE__ */ jsxs("span", { style: { marginLeft: 8, fontSize: 11, fontWeight: 400, color: ex.running ? "#16a34a" : "var(--text-dim)" }, children: [
          "\u25CF ",
          ex.running ? t("services.tunnelRunning") : t("services.tunnelStopped")
        ] })
      ] }),
      /* @__PURE__ */ jsx("button", { onClick: onClose, title: t("services.close"), "aria-label": t("services.close"), style: { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, display: "flex" }, children: /* @__PURE__ */ jsxs("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", children: [
        /* @__PURE__ */ jsx("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
        /* @__PURE__ */ jsx("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
      ] }) })
    ] }),
    /* @__PURE__ */ jsxs("div", { style: { flex: 1, overflowY: "auto", padding: "8px 16px" }, children: [
      field(t("services.exposeMode"), mode),
      field(
        t("services.exposeBasePath"),
        ex.serviceBasePath != null && ex.serviceBasePath !== "" ? ex.serviceBasePath : "\u2014"
      ),
      field(t("services.exposeProvider"), ex.provider ? ex.provider : (
        /* auth=none → 标红告警(与列表行一致) */
        /* @__PURE__ */ jsxs("span", { style: { color: "var(--danger, #f87171)", fontWeight: 600 }, title: t("services.noAuthWarnHint"), children: [
          "\u26A0 ",
          t("services.exposeProviderNone")
        ] })
      )),
      mode !== "proxy" && field(t("services.exposeTunnelTool"), ex.tunnelType ?? "\u2014"),
      userManagers.includes(ex.provider ?? "") && field(t("services.exposeSite"), ex.site && ex.site !== "" ? ex.site : "default"),
      field(t("services.exposeProtocol"), ex.protocol ?? "http"),
      field(t("services.exposeStartedAt"), startedAt ? startedAt.toLocaleString() : "\u2014"),
      field(t("services.exposeParams"), !params || Object.keys(params).length === 0 ? "\u2014" : /* @__PURE__ */ jsx("div", { style: { display: "flex", flexDirection: "column", gap: 2 }, children: Object.entries(params).map(([k, v]) => /* @__PURE__ */ jsxs("div", { style: { fontFamily: "var(--font-mono)" }, children: [
        /* @__PURE__ */ jsx("span", { style: { color: "var(--text-dim)" }, children: k }),
        ": ",
        v
      ] }, k)) })),
      field(t("services.exposeResult"), links.length === 0 ? "\u2014" : /* @__PURE__ */ jsx("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: links.map((u) => /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => onOpen(u),
            title: u,
            style: { flex: 1, minWidth: 0, textAlign: "left", padding: "4px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            children: u
          }
        ),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => onCopy(`expose-detail-${u}`, u),
            style: { flexShrink: 0, width: 28, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: copiedKey === `expose-detail-${u}` ? "#16a34a" : "var(--text-dim)", cursor: "pointer", fontSize: 11 },
            children: copiedKey === `expose-detail-${u}` ? "\u2713" : "\u29C9"
          }
        )
      ] }, u)) })),
      /* @__PURE__ */ jsx(
        LogFilesSection,
        {
          exposeName: ex.name,
          t,
          onOpenFile
        }
      )
    ] }),
    /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--border)", flexShrink: 0 }, children: [
      /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: "var(--text-dim)", flex: 1 }, children: t("services.exposeDetailHint") }),
      /* @__PURE__ */ jsx("button", { onClick: onStop, style: { flexShrink: 0, padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--danger, #f87171)", cursor: "pointer", fontSize: 12, fontWeight: 600 }, children: t("services.exposeStop") })
    ] })
  ] }) });
}
function LogFilesSection({ exposeName, t, onOpenFile }) {
  const [files, setFiles] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch(apiUrl(`/api/extensions/service-tunnels/status?logs-list=${encodeURIComponent(exposeName)}`)).then((r) => r.json()).then((d) => {
      if (!alive) return;
      if (d.error) setErr(d.error);
      else setFiles(d.files ?? []);
    }).catch(() => {
      if (alive) setErr("(failed to load logs)");
    });
    return () => {
      alive = false;
    };
  }, [exposeName]);
  return /* @__PURE__ */ jsxs("div", { style: { padding: "5px 0" }, children: [
    /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }, children: t("services.exposeLogFiles") }),
    files === null ? /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.exposeLogFilesLoading") }) : err ? /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--danger, #f87171)" }, children: err }) : files.length === 0 ? /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.exposeNoLogs") }) : /* @__PURE__ */ jsx("div", { style: { display: "flex", flexDirection: "column", gap: 3 }, children: files.map((f) => /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      onOpenFile ? /* @__PURE__ */ jsx(
        "button",
        {
          onClick: () => onOpenFile(f.path, f.name),
          title: f.path,
          style: { flex: 1, minWidth: 0, textAlign: "left", padding: "3px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          children: f.name
        }
      ) : /* @__PURE__ */ jsx("span", { style: { flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: f.name }),
      /* @__PURE__ */ jsx("span", { style: { flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }, children: f.size >= 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : f.size >= 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${f.size} B` })
    ] }, f.path)) })
  ] });
}
function InfoModal({ kind, t, currentDomainSuffix, pagePort, basePath, onClose }) {
  const isMobile = useIsMobile();
  return /* @__PURE__ */ jsx("div", { style: { position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }, onClick: onClose, children: /* @__PURE__ */ jsxs(
    "div",
    {
      onClick: (e) => e.stopPropagation(),
      style: { width: isMobile ? "calc(100vw - 32px)" : 470, maxWidth: "calc(100vw - 32px)", maxHeight: "min(620px, 82vh)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" },
      children: [
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }, children: [
          /* @__PURE__ */ jsx("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--text)" }, children: kind === "access" ? t("services.infoAccess") : t("services.infoAuth") }),
          /* @__PURE__ */ jsx("button", { onClick: onClose, title: t("services.close"), "aria-label": t("services.close"), style: { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, display: "flex" }, children: /* @__PURE__ */ jsxs("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", children: [
            /* @__PURE__ */ jsx("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
            /* @__PURE__ */ jsx("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
          ] }) })
        ] }),
        /* @__PURE__ */ jsx("div", { style: { flex: 1, overflowY: "auto", padding: "12px 16px", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }, children: kind === "access" ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("div", { children: [
            "\u2022 ",
            t("services.exposeLocal")
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            "\u2022 ",
            t("services.exposeLan")
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            "\u2022 ",
            t("services.exposePublic")
          ] }),
          currentDomainSuffix && /* @__PURE__ */ jsxs("div", { children: [
            "\u2022 ",
            t("services.configCurrent", { host: currentDomainSuffix.replace(/^\./, ""), pagePort, basePath })
          ] }),
          /* @__PURE__ */ jsxs("div", { style: { marginTop: 6 }, children: [
            "\u2022 ",
            t("services.exposeTunnel")
          ] })
        ] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx("div", { style: { color: "#d97706", background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.3)", borderRadius: 6, padding: "6px 8px", marginBottom: 6 }, children: t("services.authHint") }),
          /* @__PURE__ */ jsx("div", { style: { fontWeight: 600, color: "var(--text-muted)", margin: "8px 0 4px" }, children: t("services.authBuiltinTitle") }),
          /* @__PURE__ */ jsxs("div", { children: [
            "\u2022 ",
            t("services.authBuiltinPortal")
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            "\u2022 ",
            t("services.authBuiltinBasic")
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            "\u2022 ",
            t("services.authBuiltinAuthelia")
          ] }),
          /* @__PURE__ */ jsx("div", { style: { fontWeight: 600, color: "var(--text-muted)", margin: "12px 0 4px" }, children: t("services.authExtendTitle") }),
          t("services.authExtendList").split("\n").map((line, i) => /* @__PURE__ */ jsxs("div", { children: [
            "\u2022 ",
            line
          ] }, i))
        ] }) })
      ]
    }
  ) });
}
function ConfirmDialog({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  return /* @__PURE__ */ jsx("div", { style: { position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }, onClick: onCancel, children: /* @__PURE__ */ jsxs("div", { onClick: (e) => e.stopPropagation(), style: { width: 440, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }, children: [
    /* @__PURE__ */ jsxs("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--danger, #f87171)", marginBottom: 8 }, children: [
      "\u26A0 ",
      title
    ] }),
    /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }, children: body }),
    /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end", flexWrap: "wrap" }, children: [
      /* @__PURE__ */ jsx("button", { onClick: onCancel, style: { padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }, children: cancelLabel }),
      /* @__PURE__ */ jsx("button", { onClick: onConfirm, style: { padding: "5px 14px", background: "#dc2626", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }, children: confirmLabel })
    ] })
  ] }) });
}
function UrlRow({ url, label, copied, onCopy, onOpen, isMobile }) {
  return /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 6, background: "var(--bg)" }, children: [
    /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: "var(--text-dim)", minWidth: isMobile ? 66 : 92, flexShrink: 0 }, children: label }),
    /* @__PURE__ */ jsx(
      "button",
      {
        onClick: onOpen,
        title: url,
        style: { flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
        children: url
      }
    ),
    /* @__PURE__ */ jsx("button", { onClick: onCopy, title: copied ? "\u2713" : "\u29C9", style: { flexShrink: 0, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 5, color: copied ? "#16a34a" : "var(--text-dim)", cursor: "pointer", fontSize: 12 }, children: copied ? "\u2713" : "\u29C9" })
  ] });
}
function AuthExposeSection({ port, t, openInNewTab, exposes, onStopExpose, onChanged, onGoManageUsers, serviceBasePath, onSetBasePath, injectSources }) {
  const { locale: secLocale } = useI18n();
  const [provider, setProvider] = useState(null);
  const [providers, setProviders] = useState([]);
  const [tunnel, setTunnel] = useState("cloudflared");
  const [protocol, setProtocol] = useState("http");
  const [mode, setMode] = useState("tunnel");
  const [site, setSite] = useState("");
  const [sites, setSites] = useState([]);
  const [tcpTunnels, setTcpTunnels] = useState([]);
  const [tunnelSchemas, setTunnelSchemas] = useState(null);
  const [tunnelMetas, setTunnelMetas] = useState(null);
  const [authSchemas, setAuthSchemas] = useState(null);
  const [authMetas, setAuthMetas] = useState(null);
  const [tunnelParams, setTunnelParams] = useState({});
  const [providerParams, setProviderParams] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [confirmNone, setConfirmNone] = useState(false);
  const [userManagers, setUserManagers] = useState([]);
  const [userManagersReady, setUserManagersReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [noUsers, setNoUsers] = useState(null);
  const [userConfirm, setUserConfirm] = useState(null);
  const [presets, setPresets] = useState([]);
  const [lastUsedAt, setLastUsedAt] = useState(null);
  const [presetId, setPresetId] = useState("__last__");
  const [presetName, setPresetName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [presetActions, setPresetActions] = useState({ enroll: false, expose: false });
  const [bpDraft, setBpDraft] = useState(null);
  const [injectSel, setInjectSel] = useState([]);
  const [loginInfoButton2, setLoginInfoButton] = useState(false);
  const [presetBusy, setPresetBusy] = useState(false);
  const prefilledRef = useRef(false);
  const applyPresetConfig = (cfg) => {
    prefilledRef.current = true;
    setProvider(cfg.provider ?? "none");
    setInjectSel(Array.isArray(cfg.inject) ? cfg.inject.filter((s) => typeof s === "string") : []);
    setLoginInfoButton(cfg.loginInfoButton === true);
    setTunnel(cfg.tunnel || "cloudflared");
    setProtocol(cfg.protocol ?? "http");
    setMode(cfg.protocol === "tcp" ? "tunnel" : cfg.mode ?? "tunnel");
    setSite(cfg.site ?? "");
    setTunnelParams({ ...cfg.tunnelParams ?? {} });
    setProviderParams({ ...cfg.providerParams ?? {} });
    if (cfg.serviceBasePath !== void 0 && cfg.serviceBasePath !== (serviceBasePath ?? "")) {
      onSetBasePath?.(port, cfg.serviceBasePath);
    }
  };
  const loadPresetIntoForm = (id) => {
    setPresetBusy(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-load", id })
    }).then((r) => r.json()).then((d) => {
      if (d.error || !d.config) {
        if (id !== "__last__") setError(d.error ?? t("services.presetLoadFailed"));
        return;
      }
      setError(null);
      applyPresetConfig(d.config);
      if (id !== "__last__") applyPresetActions(d.config);
    }).catch(() => {
      if (id !== "__last__") setError(t("services.presetLoadFailed"));
    }).finally(() => setPresetBusy(false));
  };
  const applyPresetActions = (cfg) => {
    const actions = cfg.actions;
    if (!actions) return;
    if (actions.enroll) {
      const body = { port, ...cfg.serviceBasePath ? { basePath: cfg.serviceBasePath } : {} };
      fetch(apiUrl("/api/extensions/service-tunnels/enroll"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).catch(() => {
      });
    }
    if (actions.expose) {
      go({
        provider: cfg.provider ?? (cfg.protocol === "tcp" ? null : "none"),
        tunnel: cfg.tunnel || "cloudflared",
        protocol: cfg.protocol,
        mode: cfg.mode,
        site: cfg.site ?? "",
        tunnelParams: cfg.tunnelParams,
        providerParams: cfg.providerParams,
        ...cfg.serviceBasePath ? { serviceBasePath: cfg.serviceBasePath } : {}
      });
    }
  };
  useEffect(() => {
    setPresetBusy(true);
    const statusP = fetch(`${apiUrl("/api/extensions/service-tunnels/status")}?lang=${encodeURIComponent(secLocale)}`).then((r) => r.json()).catch(() => null);
    const presetP = fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-load", id: "__last__" })
    }).then((r) => r.json()).catch(() => null);
    Promise.all([statusP, presetP]).then(([d, presetD]) => {
      if (!d) return;
      {
        const order = d.providerOrder ?? ["portal", "basic"];
        setProviders(["none", ...order]);
        const preferred = d.defaultProvider ?? order[0] ?? "portal";
        setProvider((cur) => cur === null ? order.includes(preferred) ? preferred : order[0] ?? "portal" : cur);
        if (d.tunnelSchemas) setTunnelSchemas(d.tunnelSchemas);
        if (d.tunnelMetas) setTunnelMetas(d.tunnelMetas);
        if (d.authProviderSchemas) setAuthSchemas(d.authProviderSchemas);
        if (d.authMetas) setAuthMetas(d.authMetas);
        if (d.tunnelTcpSupport) setTcpTunnels(d.tunnelTcpSupport.filter((k) => !d.tunnelMetas?.[k]?.dangerous && k !== "command"));
        if (d.sites) setSites(d.sites.filter((s) => s.name !== "default").map((s) => s.name));
        if (d.userManagers) setUserManagers(d.userManagers);
        setUserManagersReady(true);
        if (d.exposePresets) {
          setPresets(d.exposePresets.presets ?? []);
          setLastUsedAt(d.exposePresets.lastUsedAt ?? null);
          if (d.exposePresets.lastUsedAt && presetD?.config) applyPresetConfig(presetD.config);
        }
      }
    }).finally(() => setPresetBusy(false));
  }, []);
  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    fetch(apiUrl(`/api/extensions/service-tunnels/status?detect=${port}`)).then((r) => r.json()).then((d) => {
      if (!cancelled && d.protocol && !prefilledRef.current) setProtocol(d.protocol);
    }).catch(() => {
    });
    return () => {
      cancelled = true;
    };
  }, [port]);
  const doExpose = (overrides) => {
    const p = overrides?.provider ?? (protocol === "tcp" ? null : provider);
    const t2 = overrides?.tunnel ?? tunnel;
    const proto = overrides?.protocol ?? protocol;
    const m = overrides?.mode ?? (proto === "tcp" ? "tunnel" : mode);
    const s = overrides?.site ?? site;
    const tp = overrides?.tunnelParams ?? tunnelParams;
    const pp = overrides?.providerParams ?? providerParams;
    const bp = overrides && "serviceBasePath" in overrides ? overrides.serviceBasePath : serviceBasePath;
    setBusy(true);
    setError(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "expose",
        port,
        auth: p !== "none" && proto !== "tcp",
        // tcp exposes never carry gateway auth — the library's expose tcp
        // path ignores the provider; send it as-is (no name hardcoding here).
        provider: p,
        tunnel: t2,
        protocol: proto,
        mode: m,
        site: s || void 0,
        tunnelParams: tp,
        providerParams: pp,
        ...bp ? { serviceBasePath: bp } : {},
        ...injectSel.length ? { inject: injectSel } : {},
        ...loginInfoButton2 ? { loginInfoButton: true } : {}
      })
    }).then((r) => r.json()).then((d) => {
      if (d.error) {
        setError(d.error);
        setResult(null);
      } else {
        setResult({ url: d.url ?? null, loginUrl: d.loginUrl, localUrl: d.localUrl, baseUrl: d.baseUrl, domainUrl: d.domainUrl });
        setLastUsedAt(Date.now());
        setPresetId("__last__");
        onChanged();
      }
    }).catch((e) => setError(String(e))).finally(() => setBusy(false));
  };
  const checkUsers = (overrides) => {
    const p = overrides ? overrides.provider ?? "none" : protocol === "tcp" ? null : provider;
    const s = overrides ? overrides.site ?? "" : site;
    if (!userManagersReady) {
      setError(t("services.userCheckUnavailable"));
      return;
    }
    if (!p || !userManagers.includes(p)) {
      doExpose(overrides);
      return;
    }
    setChecking(true);
    setError(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "user-list", provider: p, site: s || void 0 })
    }).then((r) => r.json()).then((d) => {
      if (d.error) {
        setError(d.error);
        return;
      }
      const entry = (d.users ?? []).find((x) => x.provider === provider);
      const users = entry?.users ?? [];
      if (users.length === 0) {
        setNoUsers({ provider, site: site || "default" });
        return;
      }
      setUserConfirm({
        provider,
        site: site || "default",
        users: users.map((u) => u.displayName || u.name)
      });
    }).catch(() => setError(String(t("services.error")))).finally(() => setChecking(false));
  };
  const exposeOverrideRef2 = useRef(null);
  const go = (overrides) => {
    exposeOverrideRef2.current = overrides ?? null;
    const p = overrides ? overrides.provider ?? "none" : protocol === "tcp" ? null : provider;
    const proto = overrides ? overrides.protocol ?? "http" : protocol;
    if (p === "none" || proto === "tcp") {
      setConfirmNone(true);
      return;
    }
    checkUsers(overrides);
  };
  const effectiveMode = protocol === "tcp" ? "tunnel" : mode;
  const selectedProvider = protocol === "tcp" ? void 0 : provider === "none" ? void 0 : provider;
  const normSite = (s) => s === void 0 || s === "" ? "default" : s;
  const existing = exposes.find((e) => {
    if (e.port !== port || !e.running) return false;
    const m = (e.name ?? "").startsWith("proxy:") ? "proxy" : (
      // both-mode records carry localUrl ("" when transport is in-process,
      // i.e. pi-web's middleware); tunnel-only records have none.
      e.localUrl !== void 0 ? "both" : "tunnel"
    );
    if (m !== effectiveMode) return false;
    if (effectiveMode !== "proxy") {
      if (e.tunnelType !== tunnel) return false;
      if (e.protocol && e.protocol !== protocol) return false;
    }
    if ((e.provider ?? void 0) !== (selectedProvider ?? void 0)) return false;
    if (normSite(e.site) !== normSite(site || void 0)) return false;
    return true;
  });
  const stop = () => {
    if (!existing) return;
    setResult(null);
    setError(null);
    onStopExpose(existing.name);
  };
  const select = { padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, flexShrink: 0 };
  const currentConfig = () => ({
    provider: protocol === "tcp" ? null : provider ?? null,
    tunnel: tunnel || "cloudflared",
    protocol,
    mode: protocol === "tcp" ? "tunnel" : mode,
    site: site || "",
    serviceBasePath: serviceBasePath ?? "",
    tunnelParams: { ...tunnelParams },
    providerParams: { ...providerParams },
    inject: [...injectSel],
    loginInfoButton: loginInfoButton2,
    // 一键动作：方案应用后自动执行（enroll/expose/开启注入源）
    actions: {
      ...presetActions.enroll ? { enroll: true } : {},
      ...presetActions.expose ? { expose: true } : {}
    }
  });
  const suggestPresetName = () => {
    const modePart = protocol === "tcp" ? "tunnel" : mode;
    const authPart = protocol === "tcp" || !provider || provider === "none" ? "none" : provider;
    const sitePart = site || "default";
    return `${modePart}+${authPart}@${sitePart}`;
  };
  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    setPresetBusy(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-save", name, presetConfig: currentConfig() })
    }).then((r) => r.json()).then((d) => {
      if (d.error) {
        setError(d.error);
        return;
      }
      if (d.presets) setPresets(d.presets.presets ?? []);
      if (d.saved?.id) setPresetId(d.saved.id);
      setSaveOpen(false);
      setPresetName("");
      setPresetActions({ enroll: false, expose: false });
    }).catch(() => setError(t("services.error"))).finally(() => setPresetBusy(false));
  };
  const deletePreset = () => {
    if (presetId === "__last__") return;
    setPresetBusy(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-delete", id: presetId })
    }).then((r) => r.json()).then((d) => {
      if (d.error) {
        setError(d.error);
        return;
      }
      if (d.presets) setPresets(d.presets.presets ?? []);
      setPresetId("__last__");
    }).catch(() => setError(t("services.error"))).finally(() => setPresetBusy(false));
  };
  const [formReady, setFormReady] = useState(false);
  const [forceReady, setForceReady] = useState(false);
  const presetsSettled = !presetBusy;
  useEffect(() => {
    if (providers.length > 0 && (presetsSettled || forceReady) && !formReady) {
      const t2 = setTimeout(() => setFormReady(true), 0);
      return () => clearTimeout(t2);
    }
  }, [providers, presetsSettled, forceReady, formReady]);
  useEffect(() => {
    const t2 = setTimeout(() => setForceReady(true), 3e3);
    return () => clearTimeout(t2);
  }, []);
  return /* @__PURE__ */ jsxs("div", { style: { borderTop: "1px solid var(--border)", padding: "10px 0 0", marginTop: 10, background: "var(--bg-panel)" }, children: [
    /* @__PURE__ */ jsx("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "4px 0 6px" }, children: t("services.exposeSection") }),
    !formReady ? (
      /* 骨架：加载中占位（高度近似，避免跳动） */
      /* @__PURE__ */ jsxs("div", { style: { padding: "14px 0", fontSize: 11, color: "var(--text-dim)" }, children: [
        "\u23F3 ",
        t("services.exposeLoading")
      ] })
    ) : /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }, children: [
        /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.preset") }),
        /* @__PURE__ */ jsxs(
          "select",
          {
            value: presetId,
            onChange: (e) => {
              setPresetId(e.target.value);
              loadPresetIntoForm(e.target.value);
            },
            disabled: presetBusy,
            style: select,
            title: t("services.presetHint"),
            children: [
              /* @__PURE__ */ jsx("option", { value: "__last__", children: lastUsedAt ? `${t("services.presetLastUsed")}\uFF08${new Date(lastUsedAt).toLocaleString()}\uFF09` : t("services.presetLastUsedNone") }),
              presets.map((p) => /* @__PURE__ */ jsx("option", { value: p.id, children: p.name }, p.id))
            ]
          }
        ),
        presetId !== "__last__" && /* @__PURE__ */ jsx(
          "button",
          {
            onClick: deletePreset,
            disabled: presetBusy,
            title: t("services.presetDeleteHint"),
            style: { flexShrink: 0, padding: "3px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--danger, #f87171)", cursor: "pointer", fontSize: 11 },
            children: t("services.presetDelete")
          }
        ),
        !saveOpen ? /* @__PURE__ */ jsxs(
          "button",
          {
            onClick: () => {
              setSaveOpen(true);
              setPresetName(suggestPresetName());
            },
            title: t("services.presetSaveAsHint"),
            style: { flexShrink: 0, padding: "3px 10px", background: "var(--bg-hover)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text)", cursor: "pointer", fontSize: 11 },
            children: [
              "\uFF0B ",
              t("services.presetSaveAs")
            ]
          }
        ) : /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              value: presetName,
              onChange: (e) => setPresetName(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter") savePreset();
                if (e.key === "Escape") {
                  setSaveOpen(false);
                  setPresetName("");
                }
              },
              placeholder: t("services.presetNamePlaceholder"),
              autoFocus: true,
              style: { padding: "3px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, width: 120 }
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: savePreset,
              disabled: presetBusy || !presetName.trim(),
              style: { flexShrink: 0, padding: "3px 10px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: presetBusy || !presetName.trim() ? "default" : "pointer", fontSize: 11 },
              children: t("services.presetSave")
            }
          ),
          /* @__PURE__ */ jsxs("div", { style: { width: "100%", display: "flex", gap: 10, flexWrap: "wrap", padding: "2px 0 0", fontSize: 10, color: "var(--text-dim)" }, children: [
            /* @__PURE__ */ jsxs("label", { style: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }, title: t("services.presetActionsEnrollHint"), children: [
              /* @__PURE__ */ jsx("input", { type: "checkbox", checked: !!presetActions.enroll, onChange: (e) => setPresetActions((p) => ({ ...p, enroll: e.target.checked })), style: { accentColor: "var(--accent)" } }),
              t("services.presetActionsEnroll")
            ] }),
            /* @__PURE__ */ jsxs("label", { style: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }, title: t("services.presetActionsExposeHint"), children: [
              /* @__PURE__ */ jsx("input", { type: "checkbox", checked: !!presetActions.expose, onChange: (e) => setPresetActions((p) => ({ ...p, expose: e.target.checked })), style: { accentColor: "var(--accent)" } }),
              t("services.presetActionsExpose")
            ] })
          ] }),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => {
                setSaveOpen(false);
                setPresetName("");
              },
              style: { flexShrink: 0, padding: "3px 10px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 },
              children: t("services.exposeAbort")
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }, children: [
        /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.exposeMode") }),
        /* @__PURE__ */ jsxs("select", { value: protocol === "tcp" ? "tunnel" : mode, onChange: (e) => setMode(e.target.value), disabled: protocol === "tcp", style: select, children: [
          /* @__PURE__ */ jsx("option", { value: "tunnel", children: t("services.exposeModeTunnel") }),
          /* @__PURE__ */ jsx("option", { value: "proxy", children: t("services.exposeModeProxy") }),
          /* @__PURE__ */ jsx("option", { value: "both", children: t("services.exposeModeBoth") })
        ] }),
        (provider ?? "") !== "none" && userManagers.includes(provider ?? "") && /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.exposeSite") }),
          /* @__PURE__ */ jsxs("select", { value: site, onChange: (e) => setSite(e.target.value), style: select, children: [
            /* @__PURE__ */ jsx("option", { value: "", children: t("services.exposeSiteDefault") }),
            sites.map((s) => /* @__PURE__ */ jsx("option", { value: s, children: s }, s))
          ] })
        ] })
      ] }),
      mode !== "proxy" && /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }, children: [
        /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.exposeProtocol") }),
        /* @__PURE__ */ jsxs("select", { value: protocol, onChange: (e) => {
          const p = e.target.value;
          setProtocol(p);
          if (p === "tcp") setTunnel((cur) => tcpTunnels.includes(cur) ? cur : tcpTunnels[0] ?? cur);
          if (p === "tcp") setMode("tunnel");
        }, style: select, children: [
          /* @__PURE__ */ jsx("option", { value: "http", children: "http" }),
          /* @__PURE__ */ jsx("option", { value: "https", children: "https" }),
          /* @__PURE__ */ jsx("option", { value: "tcp", children: "tcp" })
        ] }),
        /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.exposeTunnelTool") }),
        /* @__PURE__ */ jsx("select", { value: tunnel, onChange: (e) => setTunnel(e.target.value), style: select, children: [...Object.entries(tunnelSchemas ?? {})].filter(([p]) => !tunnelMetas?.[p]?.dangerous && p !== "command").filter(([p]) => protocol !== "tcp" || tcpTunnels.includes(p)).sort((a, b) => {
          const fa = tunnelMetas?.[a[0]]?.favorite ? 1 : 0;
          const fb = tunnelMetas?.[b[0]]?.favorite ? 1 : 0;
          if (fa !== fb) return fb - fa;
          return a[1].length - b[1].length;
        }).map(([k]) => /* @__PURE__ */ jsxs("option", { value: k, children: [
          k,
          tunnelMetas?.[k]?.favorite ? " \u2605" : ""
        ] }, k)) })
      ] }),
      mode !== "proxy" && tunnelSchemas?.[tunnel] && /* @__PURE__ */ jsxs("div", { style: { marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }, children: [
        /* @__PURE__ */ jsxs("div", { style: { fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }, children: [
          t("services.tunnelParams"),
          tunnelMetas?.[tunnel]?.favorite && /* @__PURE__ */ jsx("span", { style: { marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "var(--accent)", color: "#fff", fontSize: 9, fontWeight: 600 }, children: t("services.recommended") })
        ] }),
        /* @__PURE__ */ jsx(SchemaForm, { specs: tunnelSchemas[tunnel], values: tunnelParams, onChange: (k, v) => setTunnelParams((prev) => ({ ...prev, [k]: v })), t })
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }, children: [
        /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: "var(--text-dim)" }, children: "Base Path" }),
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "text",
            value: bpDraft ?? serviceBasePath ?? "",
            placeholder: t("services.injectJsBasePathPlaceholder"),
            onChange: (e) => setBpDraft(e.target.value),
            onBlur: () => {
              if (bpDraft !== null) {
                onSetBasePath?.(port, bpDraft);
                setBpDraft(null);
              }
            },
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                onSetBasePath?.(port, bpDraft ?? serviceBasePath ?? "");
                setBpDraft(null);
                e.target.blur();
              }
            },
            title: t("services.injectJsBasePathHint"),
            style: { width: 90, padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)" }
          }
        )
      ] }),
      provider && provider !== "none" && protocol !== "tcp" && /* @__PURE__ */ jsxs("label", { style: { display: "flex", alignItems: "center", gap: 5, marginTop: 8, fontSize: 10, cursor: "pointer", color: loginInfoButton2 ? "var(--text)" : "var(--text-dim)" }, title: t("services.loginInfoButtonHint"), children: [
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "checkbox",
            checked: loginInfoButton2,
            onChange: (e) => setLoginInfoButton(e.target.checked),
            style: { accentColor: "var(--accent)", cursor: "pointer" }
          }
        ),
        "\u{1F464} ",
        t("services.loginInfoButton")
      ] }),
      injectSources.length > 0 && /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }, children: [
        /* @__PURE__ */ jsxs("span", { style: { fontSize: 10, color: "var(--text-dim)" }, children: [
          "\u{1F9F0} ",
          t("services.injectJs")
        ] }),
        injectSources.map((s) => {
          const on = injectSel.includes(s.id);
          return /* @__PURE__ */ jsxs("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 10, cursor: "pointer", color: on ? "var(--text)" : "var(--text-dim)" }, title: s.description ?? "", children: [
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "checkbox",
                checked: on,
                onChange: (e) => setInjectSel((prev) => e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)),
                style: { accentColor: "var(--accent)", cursor: "pointer" }
              }
            ),
            s.label
          ] }, s.id);
        })
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }, children: [
        /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.exposeProvider") }),
        /* @__PURE__ */ jsxs("select", { value: provider ?? "", onChange: (e) => {
          const next = e.target.value;
          setProvider(next);
          if (!userManagers.includes(next)) setSite("");
        }, style: select, children: [
          /* @__PURE__ */ jsx("option", { value: "", disabled: true, children: t("services.selectProvider") }),
          providers.map((p) => /* @__PURE__ */ jsx("option", { value: p, children: providerDisplayLabel(p, t, authMetas) }, p))
        ] }),
        /* @__PURE__ */ jsx("span", { style: { flex: 1 } }),
        existing ? /* @__PURE__ */ jsx(
          "button",
          {
            onClick: stop,
            title: t("services.exposeStopHint"),
            style: { flexShrink: 0, padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 600 },
            children: t("services.exposeStop")
          }
        ) : /* @__PURE__ */ jsx(
          "button",
          {
            onClick: go,
            disabled: busy || checking,
            style: { flexShrink: 0, padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: busy || checking ? "default" : "pointer", fontSize: 11, fontWeight: 600 },
            children: busy ? t("services.exposing") : t("services.exposeGo")
          }
        )
      ] }),
      provider && provider !== "none" && authSchemas?.[provider] && authSchemas[provider].length > 0 && /* @__PURE__ */ jsxs("div", { style: { marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }, children: [
        /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }, children: t("services.authParams") }),
        /* @__PURE__ */ jsx(SchemaForm, { specs: authSchemas[provider], values: providerParams, onChange: (k, v) => setProviderParams((prev) => ({ ...prev, [k]: v })), t })
      ] }),
      error && /* @__PURE__ */ jsxs("div", { style: { fontSize: 11, color: "var(--danger, #f87171)", marginTop: 6 }, children: [
        t("services.exposeFailed"),
        ": ",
        error
      ] }),
      result && (result.url || result.localUrl) && /* @__PURE__ */ jsxs("div", { style: { marginTop: 8, padding: "8px 10px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }, children: [
        /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.exposeResult") }),
        [result.url, result.localUrl, result.baseUrl, result.domainUrl].filter(Boolean).map((u) => /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => openInNewTab(u),
            style: { display: "block", maxWidth: "100%", marginTop: 2, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", textAlign: "left", overflowWrap: "anywhere", wordBreak: "break-all" },
            children: u
          },
          u
        )),
        result.loginUrl && /* @__PURE__ */ jsx(
          "button",
          {
            onClick: () => openInNewTab(result.loginUrl),
            style: { marginTop: 6, padding: "4px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 },
            children: t("services.openLogin")
          }
        )
      ] }),
      confirmNone && /* @__PURE__ */ jsx(
        ConfirmDialog,
        {
          title: t("services.confirmNoAuthTitle"),
          body: t("services.confirmNoAuthBodyPort", { port: String(port) }),
          confirmLabel: t("services.exposeConfirm"),
          cancelLabel: t("services.exposeAbort"),
          onConfirm: () => {
            setConfirmNone(false);
            doExpose(exposeOverrideRef2.current);
            exposeOverrideRef2.current = null;
            ;
          },
          onCancel: () => setConfirmNone(false)
        }
      ),
      noUsers && /* @__PURE__ */ jsx(
        ConfirmDialog,
        {
          title: t("services.confirmNoUsersTitle"),
          body: t("services.confirmNoUsersBody", { provider: noUsers.provider, site: noUsers.site }),
          confirmLabel: t("services.confirmNoUsersGo"),
          cancelLabel: t("services.exposeAbort"),
          onConfirm: () => {
            setNoUsers(null);
            onGoManageUsers();
          },
          onCancel: () => setNoUsers(null)
        }
      ),
      userConfirm && /* @__PURE__ */ jsx(
        ConfirmDialog,
        {
          title: t("services.confirmUsersTitle"),
          body: /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { style: { fontSize: 11, lineHeight: 1.7 }, children: t("services.confirmUsersBody", { provider: userConfirm.provider, site: userConfirm.site }) }),
            /* @__PURE__ */ jsx("ul", { style: { margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text)" }, children: userConfirm.users.map((u) => /* @__PURE__ */ jsx("li", { children: u }, u)) })
          ] }),
          confirmLabel: t("services.confirmUsersConfirm"),
          cancelLabel: t("services.exposeAbort"),
          onConfirm: () => {
            setUserConfirm(null);
            doExpose(exposeOverrideRef2.current);
            exposeOverrideRef2.current = null;
            ;
          },
          onCancel: () => setUserConfirm(null)
        }
      )
    ] })
  ] });
}
function isIpLikeHost(h) {
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return h.includes(":");
}
var TUNNEL_HOST_SUFFIXES = [
  ".bore.pub",
  ".loca.lt",
  ".localhost.run",
  ".ngrok.io",
  ".ngrok-free.app",
  ".ngrok.app",
  ".trycloudflare.com",
  ".serveo.net",
  ".tunnelmole.net",
  ".sharedwithexpose.com",
  ".natappfree.cc",
  ".natapp.cc"
];
function pickTotpHost(browserHost, piWebHost) {
  const h = (browserHost ?? "").toLowerCase();
  if (isIpLikeHost(h)) return piWebHost;
  if (TUNNEL_HOST_SUFFIXES.some((s) => h.endsWith(s))) return piWebHost;
  return h || piWebHost;
}
function SitesManageSection({ t, isMobile, sites, protectedSites, providers, onAdd, onRemove }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const input = { padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, flex: 1, minWidth: 0, boxSizing: "border-box" };
  const btn = { padding: "4px 12px", borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 };
  const add = async () => {
    const n = name.trim().toLowerCase();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    const res = await onAdd(n, provider);
    setBusy(false);
    if (res.error) setError(res.error);
    else setName("");
  };
  const remove = async (n) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await onRemove(n);
    setBusy(false);
    setConfirmDel(null);
    if (res.error) setError(res.error);
  };
  return /* @__PURE__ */ jsxs("div", { style: { margin: "0 0 14px", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }, children: [
    /* @__PURE__ */ jsx("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }, children: t("services.sitesManage") }),
    /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", margin: "2px 0 6px" }, children: t("services.sitesManageHint") }),
    error && /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--danger, #f87171)", margin: "4px 0" }, children: error }),
    sites === null ? /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", padding: "4px 0" }, children: t("services.loading") }) : /* @__PURE__ */ jsxs(Fragment, { children: [
      sites.map((s) => {
        const isProtected = protectedSites.includes(s.name);
        return /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", flexWrap: "wrap", borderBottom: "1px solid var(--border)" }, children: [
          /* @__PURE__ */ jsx("span", { style: { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", flexShrink: 0 }, children: s.name }),
          /* @__PURE__ */ jsx("span", { style: { padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-muted)", fontSize: 10, flexShrink: 0 }, children: s.provider || "auto" }),
          s.policy && /* @__PURE__ */ jsx("span", { style: { padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }, children: s.policy }),
          s.running && /* @__PURE__ */ jsxs("span", { style: { fontSize: 10, color: "#16a34a", flexShrink: 0 }, children: [
            "\u25CF ",
            t("services.tunnelRunning")
          ] }),
          isProtected && /* @__PURE__ */ jsxs(
            "span",
            {
              title: t("services.sitesProtectedHint"),
              style: { padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--accent)", fontSize: 10, flexShrink: 0, cursor: "help" },
              children: [
                "\u{1F512} ",
                t("services.sitesProtected")
              ]
            }
          ),
          /* @__PURE__ */ jsx("span", { style: { flex: 1 } }),
          /* @__PURE__ */ jsx(
            "button",
            {
              disabled: isProtected || busy,
              title: isProtected ? t("services.sitesProtectedHint") : t("services.sitesRemoveHint"),
              onClick: () => {
                setConfirmDel(confirmDel === s.name ? null : s.name);
                setError(null);
              },
              style: { ...btn, color: isProtected ? "var(--text-dim)" : "var(--danger, #f87171)", cursor: isProtected ? "not-allowed" : "pointer", opacity: isProtected ? 0.5 : 1 },
              children: t("services.sitesRemove")
            }
          ),
          confirmDel === s.name && !isProtected && /* @__PURE__ */ jsxs("span", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", width: isMobile ? "100%" : void 0 }, children: [
            /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: "var(--text-dim)", flex: 1, minWidth: 120 }, children: t("services.sitesRemoveConfirm", { name: s.name }) }),
            /* @__PURE__ */ jsx("button", { onClick: () => remove(s.name), disabled: busy, style: { ...btn, color: "var(--danger, #f87171)", fontWeight: 600 }, children: busy ? t("services.updating") : t("services.sitesRemoveConfirmGo") }),
            /* @__PURE__ */ jsx("button", { onClick: () => setConfirmDel(null), style: btn, children: t("services.exposeAbort") })
          ] })
        ] }, s.name);
      }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }, children: [
        /* @__PURE__ */ jsx(
          "input",
          {
            placeholder: t("services.sitesNamePlaceholder"),
            value: name,
            onChange: (e) => setName(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") add();
            },
            style: { ...input, flex: 1, width: isMobile ? "100%" : void 0 }
          }
        ),
        /* @__PURE__ */ jsxs(
          "select",
          {
            value: provider,
            onChange: (e) => setProvider(e.target.value),
            style: { ...input, flex: "0 0 auto", width: isMobile ? "100%" : void 0 },
            children: [
              /* @__PURE__ */ jsx("option", { value: "auto", children: t("services.sitesProviderAuto") }),
              providers.map((p) => /* @__PURE__ */ jsx("option", { value: p, children: p }, p))
            ]
          }
        ),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: add,
            disabled: busy || !name.trim(),
            style: { ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600, width: isMobile ? "100%" : void 0, textAlign: "center" },
            children: busy ? t("services.adding") : t("services.sitesAdd")
          }
        )
      ] })
    ] })
  ] });
}
function AuthUsersSection({ t, isMobile }) {
  const { locale: usersLocale } = useI18n();
  const [rows, setRows] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [totpProviders, setTotpProviders] = useState([]);
  const [biometricProviders, setBiometricProviders] = useState([]);
  const [faceCapture, setFaceCapture] = useState(null);
  const [captureDone, setCaptureDone] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [verifyMsg, setVerifyMsg] = useState("");
  const stateRef = useRef({ eyeClosed: false, blinked: false, vectors: [], done: false });
  const [users, setUsers] = useState([]);
  const [totpState, setTotpState] = useState({});
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [dnEdit, setDnEdit] = useState(null);
  const [pwUser, setPwUser] = useState(null);
  const [newPw, setNewPw] = useState("");
  const [totpEnrolled, setTotpEnrolled] = useState(null);
  const [totpCode, setTotpCode] = useState("");
  const [enrollTarget, setEnrollTarget] = useState(null);
  const [totpLabel, setTotpLabel] = useState("");
  const [qrUrl, setQrUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sitesList, setSitesList] = useState(null);
  const [protectedSites, setProtectedSites] = useState(["default", "pi-web"]);
  const [siteProviders, setSiteProviders] = useState([]);
  const post = (action, extra = {}) => {
    const s = selected;
    if (!s) return Promise.resolve({ error: "no combo selected" });
    return fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, provider: s.provider, site: s.site === "default" ? void 0 : s.site, ...extra })
    }).then((r) => r.json());
  };
  const loadSummary = useCallback(() => {
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "user-summary" })
    }).then((r) => r.json()).then((d) => {
      if (d.error) {
        setSummaryError(d.error);
        return;
      }
      setRows(d.rows ?? []);
      setSummaryError(null);
    }).catch(() => setSummaryError(String(t("services.error"))));
  }, [t]);
  const loadUsers = useCallback(() => {
    if (!selected) return;
    post("user-list", { provider: selected.provider }).then((d) => {
      if (d.error) {
        setError(d.error);
        return;
      }
      const entry = (d.users ?? []).find((x) => x.provider === selected.provider);
      setUsers(entry?.users ?? []);
      if (totpProviders.includes(selected.provider)) {
        for (const u of entry?.users ?? []) {
          post("totp-status", { provider: selected.provider, name: u.name }).then((s) => setTotpState((prev) => ({ ...prev, [u.name]: Boolean(s.enrolled) }))).catch(() => {
          });
        }
      }
    }).catch(() => setError(String(t("services.error"))));
  }, [selected, totpProviders, biometricProviders]);
  useEffect(() => {
    fetch(`${apiUrl("/api/extensions/service-tunnels/status")}?lang=${encodeURIComponent(usersLocale)}`).then((r) => r.json()).then((d) => {
      if (d.totpProviders) setTotpProviders(d.totpProviders);
      if (d.biometricProviders) setBiometricProviders(d.biometricProviders);
      if (d.sites) setSitesList(d.sites);
      if (d.protectedSites) setProtectedSites(d.protectedSites);
      if (d.providerOrder) setSiteProviders(d.providerOrder);
    }).catch(() => {
    });
    loadSummary();
  }, [loadSummary]);
  useEffect(() => {
    if (selected) loadUsers();
  }, [selected]);
  const selectCombo = (r) => {
    setSelected({ site: r.site, provider: r.provider });
    setError(null);
    setPwUser(null);
    setTotpEnrolled(null);
    setQrUrl(null);
    setTotpCode("");
    setEnrollTarget(null);
    setTotpLabel("");
    setUsers([]);
    setTotpState({});
  };
  const back = () => {
    setSelected(null);
    setUsers([]);
    setTotpState({});
    setError(null);
    setPwUser(null);
    setTotpEnrolled(null);
    setQrUrl(null);
    setTotpCode("");
    setEnrollTarget(null);
    setTotpLabel("");
    loadSummary();
  };
  const addUser = () => {
    if (!name || !password) return;
    setBusy(true);
    setError(null);
    post("user-add", { name, password, displayName: displayName || void 0 }).then((d) => {
      if (d.error) setError(d.error);
      else {
        setName("");
        setPassword("");
        setDisplayName("");
        loadUsers();
        loadSummary();
      }
    }).catch((e) => setError(String(e))).finally(() => setBusy(false));
  };
  const updateUserPassword = (uname) => {
    if (!newPw) return;
    setBusy(true);
    post("user-set-password", { name: uname, password: newPw }).catch((e) => setError(String(e))).finally(() => {
      setBusy(false);
      setPwUser(null);
      setNewPw("");
    });
  };
  const saveDisplayName = () => {
    if (!dnEdit || !dnEdit.draft.trim()) return;
    const prev = users.find((u) => u.name === dnEdit.name)?.displayName ?? "";
    if (dnEdit.draft.trim() === prev) {
      setDnEdit(null);
      return;
    }
    post("user-set-displayname", { provider: selected?.provider, name: dnEdit.name, displayName: dnEdit.draft.trim() }).then((d) => {
      if (d.error) {
        setError(d.error);
        return;
      }
      loadUsers();
      setDnEdit(null);
    }).catch(() => setError(String(t("services.error"))));
  };
  const enrollBiometric = (name2, method) => {
    if (method === "face") {
      setFaceCapture({ name: name2, mode: "enroll" });
      return;
    }
    post("biometric-enroll-url", { provider: selected?.provider, name: name2, method }).then((d) => {
      if (d.error) {
        setError(d.error);
        return;
      }
      if (!d.url) {
        setError(t("services.bioPortalNotRunning"));
        return;
      }
      window.open(d.url, "_blank", "noopener,noreferrer");
    }).catch(() => setError(String(t("services.error"))));
  };
  const disableBiometric = (name2, method) => {
    post("biometric-disable", { provider: selected?.provider, name: name2, method }).then((d) => {
      if (d.error) {
        setError(d.error);
        return;
      }
      loadUsers();
    }).catch(() => setError(String(t("services.error"))));
  };
  const removeUser = (uname) => {
    setBusy(true);
    post("user-remove", { name: uname }).catch((e) => setError(String(e))).finally(() => {
      setBusy(false);
      loadUsers();
      loadSummary();
    });
  };
  const startTotpEnroll = (uname) => {
    const s = selected;
    if (!s) return;
    setBusy(true);
    setError(null);
    post("totp-default-label", { name: uname }).then((d) => {
      if (d.error) {
        setError(d.error);
        return;
      }
      const host = pickTotpHost(typeof window !== "undefined" ? window.location.hostname : void 0, d.piWebHost ?? "");
      const base = `${uname}-${s.provider}-${s.site}`;
      setEnrollTarget(uname);
      setTotpLabel(host ? `${base}@${host}` : d.label ?? base);
    }).catch((e) => setError(String(e))).finally(() => setBusy(false));
  };
  const confirmTotpEnroll = () => {
    if (!enrollTarget) return;
    setBusy(true);
    setTotpEnrolled(null);
    setQrUrl(null);
    setTotpCode("");
    post("totp-enroll", { name: enrollTarget, label: totpLabel }).then((d) => {
      if (d.error) {
        setError(d.error);
        return;
      }
      if (d.secret) {
        setTotpEnrolled({ name: enrollTarget, label: d.label ?? totpLabel, secret: d.secret, otpauthUrl: d.otpauthUrl ?? "" });
        setEnrollTarget(null);
        loadUsers();
        loadSummary();
      } else {
        setError(d.error ?? t("services.totpEnrollFailed"));
      }
    }).catch((e) => setError(String(e))).finally(() => setBusy(false));
  };
  const activateTotp = () => {
    if (!totpCode || !totpEnrolled) return;
    setBusy(true);
    post("totp-activate", { name: totpEnrolled.name, code: totpCode }).then((d) => {
      if (d.activated) {
        setTotpEnrolled(null);
        setQrUrl(null);
        setTotpCode("");
        loadUsers();
        loadSummary();
      } else {
        setError(d.error ?? t("services.totpActivateFailed"));
      }
    }).catch((e) => setError(String(e))).finally(() => setBusy(false));
  };
  const disableTotp = (uname) => {
    setBusy(true);
    post("totp-disable", { name: uname }).catch((e) => setError(String(e))).finally(() => {
      setBusy(false);
      loadUsers();
      loadSummary();
    });
  };
  useEffect(() => {
    let alive = true;
    setQrUrl(null);
    const url = totpEnrolled?.otpauthUrl;
    if (!url) return;
    Promise.resolve().then(() => __toESM(require_browser(), 1)).then((mod) => {
      const qr = mod.default ?? mod;
      const toDataURL = qr.toDataURL;
      if (!toDataURL) return;
      toDataURL(url, { width: 176, margin: 1, color: { dark: "#000000", light: "#ffffff" } }).then((u) => {
        if (alive) setQrUrl(u);
      }).catch(() => {
      });
    }).catch(() => {
    });
    return () => {
      alive = false;
    };
  }, [totpEnrolled?.otpauthUrl]);
  const input = { padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, flex: 1, minWidth: 0, boxSizing: "border-box" };
  const btn = { padding: "4px 12px", borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 };
  if (selected) {
    return /* @__PURE__ */ jsxs("div", { style: { padding: "6px 0" }, children: [
      faceCapture && /* @__PURE__ */ jsx(
        FaceCaptureModal,
        {
          name: faceCapture.name,
          provider: selected.provider,
          site: selected.site === "default" ? void 0 : selected.site,
          t,
          mode: faceCapture.mode,
          onClose: () => {
            setFaceCapture(null);
          },
          onDone: () => {
            const n = faceCapture.name;
            setFaceCapture(null);
            loadUsers();
            if (faceCapture.mode === "enroll") {
              setCaptureDone({ name: n });
            } else {
              setVerifyMsg(t("services.bioFaceVerified"));
              setCaptureDone({ name: n, verified: true });
              setTimeout(() => setVerifyMsg(""), 3e3);
            }
          }
        }
      ),
      captureDone && /* @__PURE__ */ jsx("div", { style: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10001 }, onClick: () => setCaptureDone(null), children: /* @__PURE__ */ jsxs("div", { style: { background: "var(--bg-panel, #1c1c24)", borderRadius: 12, padding: 18, width: "min(90vw, 360px)" }, onClick: (e) => e.stopPropagation(), children: [
        /* @__PURE__ */ jsxs("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--text, #eee)", marginBottom: 6 }, children: [
          captureDone.verified ? "\u2705 " : "\u{1F642} ",
          captureDone.verified ? t("services.bioFaceVerified") : t("services.bioFaceRecorded")
        ] }),
        /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim, #999)", lineHeight: 1.6, marginBottom: 12 }, children: captureDone.verified ? t("services.bioFaceActiveHint") : t("services.bioFacePendingHint") }),
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" }, children: [
          !captureDone.verified && /* @__PURE__ */ jsx("button", { onClick: () => {
            const n = captureDone.name;
            setCaptureDone(null);
            setFaceCapture({ name: n, mode: "verify" });
          }, style: { ...btn, background: "var(--accent, #4f7cff)", borderStyle: "none", color: "#fff", fontWeight: 600 }, children: t("services.bioFaceVerify") }),
          /* @__PURE__ */ jsx("button", { onClick: () => {
            const n = captureDone.name;
            setCaptureDone(null);
            setFaceCapture({ name: n, mode: "enroll" });
          }, style: btn, children: t("services.bioFaceRerecord") }),
          /* @__PURE__ */ jsx("button", { onClick: () => setCaptureDone(null), style: btn, children: t("services.close") })
        ] })
      ] }) }),
      pendingAction && /* @__PURE__ */ jsx("div", { style: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10001 }, onClick: () => setPendingAction(null), children: /* @__PURE__ */ jsxs("div", { style: { background: "var(--bg-panel, #1c1c24)", borderRadius: 12, padding: 18, width: "min(90vw, 360px)" }, onClick: (e) => e.stopPropagation(), children: [
        /* @__PURE__ */ jsxs("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--text, #eee)", marginBottom: 6 }, children: [
          "\u{1F642} ",
          t("services.bioFacePending")
        ] }),
        /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim, #999)", lineHeight: 1.6, marginBottom: 12 }, children: t("services.bioFacePendingHint") }),
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" }, children: [
          /* @__PURE__ */ jsx("button", { onClick: () => {
            const n = pendingAction.name;
            setPendingAction(null);
            setFaceCapture({ name: n, mode: "verify" });
          }, style: { ...btn, background: "var(--accent, #4f7cff)", borderStyle: "none", color: "#fff", fontWeight: 600 }, children: t("services.bioFaceVerify") }),
          /* @__PURE__ */ jsx("button", { onClick: () => {
            const n = pendingAction.name;
            setPendingAction(null);
            setFaceCapture({ name: n, mode: "enroll" });
          }, style: btn, children: t("services.bioFaceRerecord") }),
          /* @__PURE__ */ jsx("button", { onClick: () => setPendingAction(null), style: btn, children: t("services.close") })
        ] })
      ] }) }),
      verifyMsg && /* @__PURE__ */ jsx("div", { style: { position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "#16a34a", color: "#fff", padding: "8px 16px", borderRadius: 8, fontSize: 12, zIndex: 10002 }, children: verifyMsg }),
      /* @__PURE__ */ jsxs("button", { onClick: back, style: { ...btn, marginBottom: 10, display: "inline-flex", alignItems: "center", gap: 4 }, children: [
        "\u2190 ",
        t("services.usersBack")
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 2 }, children: [
        t("services.usersEditing"),
        " \xB7 ",
        /* @__PURE__ */ jsx("span", { style: { fontFamily: "var(--font-mono)" }, children: selected.site }),
        " / ",
        /* @__PURE__ */ jsx("span", { style: { fontFamily: "var(--font-mono)" }, children: selected.provider }),
        /* @__PURE__ */ jsxs("span", { style: { marginLeft: 6, color: "var(--text-dim)", fontWeight: 400 }, children: [
          "(",
          users.length,
          ")"
        ] })
      ] }),
      error && /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--danger, #f87171)", margin: "6px 0" }, children: error }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, margin: "10px 0 10px", flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }, children: [
        /* @__PURE__ */ jsx("input", { placeholder: t("services.userName"), value: name, onChange: (e) => setName(e.target.value), style: { ...input, flex: 1, width: isMobile ? "100%" : void 0, boxSizing: "border-box" } }),
        /* @__PURE__ */ jsx("input", { placeholder: t("services.userPassword"), type: "password", value: password, onChange: (e) => setPassword(e.target.value), style: { ...input, flex: 1, width: isMobile ? "100%" : void 0, boxSizing: "border-box" } }),
        /* @__PURE__ */ jsx("input", { placeholder: t("services.userDisplayName"), value: displayName, onChange: (e) => setDisplayName(e.target.value), style: { ...input, flex: 1, width: isMobile ? "100%" : void 0, boxSizing: "border-box" } }),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: addUser,
            disabled: busy || !name || !password,
            style: { ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600, width: isMobile ? "100%" : void 0, textAlign: "center" },
            children: busy ? t("services.adding") : t("services.addUser")
          }
        )
      ] }),
      enrollTarget && /* @__PURE__ */ jsxs("div", { style: { margin: "8px 0", padding: "8px 10px", borderRadius: 6, background: "var(--bg)", border: "1px solid #f0c36d" }, children: [
        /* @__PURE__ */ jsxs("div", { style: { fontSize: 10, color: "#8a6d1a", marginBottom: 4 }, children: [
          t("services.totpLabelHint"),
          " \xB7 ",
          /* @__PURE__ */ jsx("span", { style: { fontFamily: "var(--font-mono)" }, children: enrollTarget })
        ] }),
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }, children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              value: totpLabel,
              onChange: (e) => setTotpLabel(e.target.value),
              placeholder: t("services.totpLabelPlaceholder"),
              style: { ...input, fontFamily: "var(--font-mono)" }
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: confirmTotpEnroll,
              disabled: busy || !totpLabel.trim(),
              style: { ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600 },
              children: busy ? t("services.adding") : t("services.totpEnrollConfirm")
            }
          ),
          /* @__PURE__ */ jsx("button", { onClick: () => {
            setEnrollTarget(null);
            setTotpLabel("");
          }, style: btn, children: t("services.close") })
        ] })
      ] }),
      users.length === 0 ? /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)" }, children: t("services.noUsers") }) : users.map((u) => /* @__PURE__ */ jsxs("div", { style: { padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)", marginBottom: 4 }, children: [
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }, children: [
          dnEdit?.name === u.name ? /* @__PURE__ */ jsxs("span", { style: { display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }, children: [
            /* @__PURE__ */ jsx(
              "input",
              {
                autoFocus: true,
                value: dnEdit.draft,
                onChange: (e) => setDnEdit({ name: u.name, draft: e.target.value }),
                onKeyDown: (e) => {
                  if (e.key === "Enter") saveDisplayName();
                  if (e.key === "Escape") setDnEdit(null);
                },
                maxLength: 64,
                style: { padding: "1px 6px", border: "1px solid var(--accent)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", fontSize: 12, fontWeight: 600, width: 110 }
              }
            ),
            /* @__PURE__ */ jsx("button", { onClick: saveDisplayName, title: t("services.save"), style: { ...btn, padding: "2px 8px" }, children: "\u2713" }),
            /* @__PURE__ */ jsx("button", { onClick: () => setDnEdit(null), title: t("services.cancel"), style: { ...btn, padding: "2px 8px" }, children: "\u2715" })
          ] }) : /* @__PURE__ */ jsxs(
            "span",
            {
              onClick: () => setDnEdit({ name: u.name, draft: u.displayName }),
              title: t("services.displayNameEditHint"),
              style: { fontSize: 12, fontWeight: 600, color: "var(--text)", flexShrink: 0, cursor: "pointer", borderBottom: "1px dashed var(--border)" },
              children: [
                u.displayName,
                " \u270E"
              ]
            }
          ),
          /* @__PURE__ */ jsx("span", { style: { fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", flexShrink: 0 }, children: u.name }),
          /* @__PURE__ */ jsx("span", { style: { fontSize: 10, color: totpState[u.name] ? "#16a34a" : "var(--text-dim)", flexShrink: 0 }, children: totpState[u.name] ? t("services.totpEnrolled") : t("services.totpOff") }),
          u.biometrics?.face && /* @__PURE__ */ jsxs("span", { style: { fontSize: 10, color: "#16a34a", flexShrink: 0 }, title: t("services.bioFaceOn"), children: [
            "\u{1F642} ",
            t("services.bioFaceOn")
          ] }),
          u.biometrics?.facePending && !u.biometrics?.face && /* @__PURE__ */ jsxs("span", { style: { fontSize: 10, color: "var(--warn, #f59e0b)", flexShrink: 0 }, title: t("services.bioFacePendingHint"), children: [
            "\u{1F642} ",
            t("services.bioFacePending")
          ] }),
          u.biometrics?.voice && /* @__PURE__ */ jsxs("span", { style: { fontSize: 10, color: "#16a34a", flexShrink: 0 }, title: t("services.bioVoiceOn"), children: [
            "\u{1F399} ",
            t("services.bioVoiceOn")
          ] }),
          u.biometrics?.voicePending && !u.biometrics?.voice && /* @__PURE__ */ jsxs("span", { style: { fontSize: 10, color: "var(--warn, #f59e0b)", flexShrink: 0 }, title: t("services.bioVoicePendingHint"), children: [
            "\u{1F399} ",
            t("services.bioVoicePending")
          ] }),
          /* @__PURE__ */ jsx("span", { style: { flex: 1 } }),
          totpProviders.includes(selected.provider) && (totpState[u.name] ? /* @__PURE__ */ jsx("button", { onClick: () => disableTotp(u.name), style: btn, children: t("services.totpDisable") }) : /* @__PURE__ */ jsx("button", { onClick: () => startTotpEnroll(u.name), style: btn, children: t("services.totpEnroll") })),
          biometricProviders.includes(selected.provider) && /* @__PURE__ */ jsxs(Fragment, { children: [
            u.biometrics?.face ? /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsx("button", { onClick: () => enrollBiometric(u.name, "face"), style: btn, title: t("services.bioFaceRerecordHint"), children: t("services.bioFaceRerecordFace") }),
              /* @__PURE__ */ jsx("button", { onClick: () => disableBiometric(u.name, "face"), style: { ...btn, color: "var(--danger, #f87171)" }, title: t("services.bioFaceOffHint"), children: t("services.bioFaceOff") })
            ] }) : u.biometrics?.facePending ? /* @__PURE__ */ jsx("button", { onClick: () => setPendingAction({ name: u.name }), style: { ...btn, borderColor: "var(--warn, #f59e0b)", color: "var(--warn, #f59e0b)" }, title: t("services.bioFacePendingHint"), children: t("services.bioFacePending") }) : /* @__PURE__ */ jsx("button", { onClick: () => enrollBiometric(u.name, "face"), style: btn, title: t("services.bioFaceHint"), children: t("services.bioFaceEnroll") }),
            u.biometrics?.voice ? /* @__PURE__ */ jsx("button", { onClick: () => disableBiometric(u.name, "voice"), style: btn, title: t("services.bioVoiceOffHint"), children: t("services.bioVoiceOff") }) : u.biometrics?.voicePending ? /* @__PURE__ */ jsx("button", { disabled: true, style: { ...btn, opacity: 0.6, cursor: "not-allowed" }, title: t("services.bioVoicePendingHint"), children: t("services.bioVoicePending") }) : /* @__PURE__ */ jsx("button", { onClick: () => enrollBiometric(u.name, "voice"), style: btn, title: t("services.bioVoiceHint"), children: t("services.bioVoiceEnroll") })
          ] }),
          /* @__PURE__ */ jsx("button", { onClick: () => setPwUser(pwUser === u.name ? null : u.name), style: btn, children: t("services.userSetPassword") }),
          /* @__PURE__ */ jsx("button", { onClick: () => removeUser(u.name), style: { ...btn, color: "var(--danger, #f87171)" }, children: t("services.userRemove") })
        ] }),
        pwUser === u.name && /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 6 }, children: [
          /* @__PURE__ */ jsx("input", { type: "password", placeholder: t("services.newPassword"), value: newPw, onChange: (e) => setNewPw(e.target.value), style: input }),
          /* @__PURE__ */ jsx("button", { onClick: () => updateUserPassword(u.name), disabled: busy || !newPw, style: { ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600 }, children: t("services.update") })
        ] })
      ] }, u.name)),
      totpEnrolled && /* @__PURE__ */ jsxs("div", { style: { marginTop: 8, padding: "10px", borderRadius: 6, background: "var(--bg)", border: "1px solid #f0c36d" }, children: [
        /* @__PURE__ */ jsxs("div", { style: { fontSize: 10, color: "#8a6d1a" }, children: [
          t("services.totpSecret"),
          " (",
          totpEnrolled.label,
          ")"
        ] }),
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 12, alignItems: "flex-start", marginTop: 6, flexWrap: "wrap" }, children: [
          qrUrl && // TOTP QR is a server-provided data URL — next/image cannot
          // optimize it (no loader, dynamic base64).
          // eslint-disable-next-line @next/next/no-img-element
          /* @__PURE__ */ jsx(
            "img",
            {
              src: qrUrl,
              alt: "TOTP QR",
              width: 176,
              height: 176,
              style: { border: "1px solid var(--border)", borderRadius: 6, flexShrink: 0, background: "#fff" }
            }
          ),
          /* @__PURE__ */ jsxs("div", { style: { flex: 1, minWidth: 220 }, children: [
            /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.totpManual") }),
            /* @__PURE__ */ jsx("div", { style: { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", marginTop: 2, overflowWrap: "anywhere", wordBreak: "break-all", letterSpacing: 1 }, children: totpEnrolled.secret }),
            totpEnrolled.otpauthUrl && /* @__PURE__ */ jsx("a", { href: totpEnrolled.otpauthUrl, style: { display: "inline-block", marginTop: 4, fontSize: 11, color: "var(--accent)" }, children: t("services.otpauthOpen") }),
            /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--text-muted)", marginTop: 8, fontWeight: 600 }, children: t("services.totpApps") }),
            /* @__PURE__ */ jsxs("ul", { style: { margin: "4px 0 0", paddingLeft: 16, fontSize: 11, color: "var(--text)", lineHeight: 1.7 }, children: [
              /* @__PURE__ */ jsxs("li", { children: [
                t("services.totpAppMs"),
                " ",
                /* @__PURE__ */ jsx("a", { href: "https://www.microsoft.com/security/mobile-authenticator-app", target: "_blank", rel: "noreferrer", style: { color: "var(--accent)" }, children: t("services.officialSite") }),
                " \xB7 ",
                /* @__PURE__ */ jsx("a", { href: "https://apps.apple.com/cn/app/microsoft-authenticator/id983156458", target: "_blank", rel: "noreferrer", style: { color: "var(--accent)" }, children: t("services.appStore") }),
                " \xB7 ",
                t("services.totpAppCnStore")
              ] }),
              /* @__PURE__ */ jsxs("li", { children: [
                t("services.totpAppTencent"),
                " ",
                t("services.totpAppCnStore")
              ] }),
              /* @__PURE__ */ jsxs("li", { children: [
                t("services.totpAppGoogle"),
                " ",
                /* @__PURE__ */ jsx("a", { href: "https://gitee.com/justdb-mirrors/downloads/releases/download/google-authenticator-6.0/GoogleAuthenticator-6.0.apk", target: "_blank", rel: "noreferrer", style: { color: "var(--accent)" }, children: t("services.totpApkMirror") })
              ] })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { style: { marginTop: 8 }, children: [
          /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }, children: t("services.totpActivateHint") }),
          /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 6 }, children: [
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "text",
                placeholder: t("services.totpCode"),
                value: totpCode,
                onChange: (e) => setTotpCode(e.target.value),
                style: input
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                onClick: () => activateTotp(),
                disabled: busy || !totpCode,
                style: { ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600 },
                children: busy ? t("services.activating") : t("services.totpActivate")
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ jsx("button", { onClick: () => {
          setTotpEnrolled(null);
          setQrUrl(null);
          setTotpCode("");
        }, style: { ...btn, marginTop: 8, display: "block" }, children: t("services.close") })
      ] })
    ] });
  }
  const addSite = (n, p) => fetch(apiUrl("/api/extensions/service-tunnels/status"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "site-add", name: n, ...p && p !== "auto" ? { provider: p } : {} })
  }).then((r) => r.json()).then((d) => {
    if (d.error) return { error: d.error };
    if (d.sites) setSitesList(d.sites);
    if (d.protectedSites) setProtectedSites(d.protectedSites);
    loadSummary();
    return {};
  }).catch((e) => ({ error: String(e) }));
  const removeSite = (n) => fetch(apiUrl("/api/extensions/service-tunnels/status"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "site-remove", name: n })
  }).then((r) => r.json()).then((d) => {
    if (d.error) return { error: d.error };
    if (d.sites) setSitesList(d.sites);
    if (d.protectedSites) setProtectedSites(d.protectedSites);
    loadSummary();
    return {};
  }).catch((e) => ({ error: String(e) }));
  return /* @__PURE__ */ jsxs("div", { style: { padding: "6px 0" }, children: [
    /* @__PURE__ */ jsx("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }, children: t("services.authUsers") }),
    /* @__PURE__ */ jsx(SitesManageSection, { t, isMobile, sites: sitesList, protectedSites, providers: siteProviders, onAdd: addSite, onRemove: removeSite }),
    /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }, children: t("services.usersPickCombo") }),
    summaryError && /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--danger, #f87171)", margin: "0 0 6px" }, children: summaryError }),
    rows === null ? /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", padding: "8px 4px" }, children: t("services.loading") }) : rows.length === 0 ? /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", padding: "8px 4px" }, children: t("services.noUserCombos") }) : /* @__PURE__ */ jsxs("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 }, children: [
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
        /* @__PURE__ */ jsx("th", { style: { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600 }, children: t("services.usersSite") }),
        /* @__PURE__ */ jsx("th", { style: { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600 }, children: t("services.usersAuth") }),
        /* @__PURE__ */ jsx("th", { style: { textAlign: "right", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600 }, children: t("services.usersCount") }),
        /* @__PURE__ */ jsx("th", { style: { textAlign: "right", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600 }, children: t("services.usersTotpCount") })
      ] }) }),
      /* @__PURE__ */ jsx("tbody", { children: rows.map((r) => /* @__PURE__ */ jsxs(
        "tr",
        {
          onClick: () => selectCombo(r),
          onMouseEnter: (e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
          },
          onMouseLeave: (e) => {
            e.currentTarget.style.background = "transparent";
          },
          style: { cursor: "pointer" },
          children: [
            /* @__PURE__ */ jsx("td", { style: { padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }, children: r.site }),
            /* @__PURE__ */ jsx("td", { style: { padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text)", fontSize: 11 }, children: r.provider }),
            /* @__PURE__ */ jsx("td", { style: { padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums" }, children: r.count }),
            /* @__PURE__ */ jsx("td", { style: { padding: "6px 8px", borderBottom: "1px solid var(--border)", color: r.totp > 0 ? "#16a34a" : "var(--text-dim)", textAlign: "right", fontVariantNumeric: "tabular-nums" }, children: r.totp })
          ]
        },
        `${r.site}:${r.provider}`
      )) })
    ] })
  ] });
}
function SelfTab({ self, t, openInNewTab, copy, copiedKey, onChanged, onGoManageUsers, exposes, onShowDetail, onStopExpose, injectSources }) {
  const { locale: selfLocale } = useI18n();
  const exposeFor = (u) => u.tunnel ? exposes.find((e) => e.name === u.tunnel) : exposes.find((e) => e.localUrl === u.url || e.baseUrl === u.url || e.domainUrl === u.url);
  const openOrDetail = (u) => {
    if (!u.authEntry || (u.label ?? "").includes("allowHost")) {
      openInNewTab(u.url);
      return;
    }
    const ex = exposeFor(u);
    if (ex) onShowDetail(ex);
    else openInNewTab(u.url);
  };
  const vhostStopName = (u) => {
    if (u.tunnel || !u.authEntry || (u.label ?? "").includes("allowHost")) return void 0;
    if (u.exposeName && (u.exposeName ?? "").startsWith("proxy:")) return u.exposeName;
    const ex = exposeFor(u) ?? exposes.find(
      (e) => e.port === self?.port && (e.site === "pi-web" || (e.name ?? "").startsWith("expose-self-")) && (e.name ?? "").startsWith("proxy:")
    );
    return ex && (ex.name ?? "").startsWith("proxy:") ? ex.name : void 0;
  };
  const [mode, setMode] = useState("tunnel");
  const [auth, setAuth] = useState("portal");
  const [providers, setProviders] = useState(null);
  const [tunnel, setTunnel] = useState("cloudflared");
  const [tunnelSchemas, setTunnelSchemas] = useState(null);
  const [tunnelMetas, setTunnelMetas] = useState(null);
  const [tunnelParams, setTunnelParams] = useState({});
  const [providerParams, setProviderParams] = useState({});
  const [authSchemas, setAuthSchemas] = useState(null);
  const [authMetas, setAuthMetas] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [copiedEnv, setCopiedEnv] = useState(false);
  const [allowHostsInput, setAllowHostsInput] = useState("");
  const [allowHostsTouched, setAllowHostsTouched] = useState(false);
  const [confirmNone, setConfirmNone] = useState(false);
  const [userManagers, setUserManagers] = useState([]);
  const [userManagersReady, setUserManagersReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [noUsers, setNoUsers] = useState(null);
  const [userConfirm, setUserConfirm] = useState(null);
  const exposing = self?.exposing ?? false;
  const allowLocal = self?.allowLocal ?? true;
  const hostname = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
  const warnNonLoopback = exposing && !loopback;
  const btn = {
    padding: "5px 12px",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 12,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "none",
    color: "var(--text)"
  };
  const select = {
    padding: "4px 6px",
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontSize: 12
  };
  useEffect(() => {
    fetch(`${apiUrl("/api/extensions/service-tunnels/status")}?lang=${encodeURIComponent(selfLocale)}`).then((r) => r.json()).then((d) => {
      const order = d.providerOrder ?? ["portal", "basic"];
      setProviders(["none", ...order]);
      if (self?.auth && order.includes(self.auth)) setAuth(self.auth);
      if (d.tunnelSchemas) setTunnelSchemas(d.tunnelSchemas);
      if (d.tunnelMetas) setTunnelMetas(d.tunnelMetas);
      if (d.authProviderSchemas) setAuthSchemas(d.authProviderSchemas);
      if (d.authMetas) setAuthMetas(d.authMetas);
      if (d.userManagers) setUserManagers(d.userManagers);
      setUserManagersReady(true);
      if (d.tunnelSchemas && d.tunnelMetas) {
        const available = Object.keys(d.tunnelSchemas).filter(
          (k) => !d.tunnelMetas?.[k]?.dangerous && k !== "command"
        );
        if (!available.includes("cloudflared")) setTunnel(available[0] ?? "cloudflared");
      }
    }).catch(() => {
    });
  }, []);
  const toggleAllowLocal = (v) => {
    if (v === false) {
      if (authEntries.length === 0) {
        setRejectDialog(true);
        return;
      }
      setErr(null);
      setRestoredNotice(false);
      fetch(apiUrl("/api/extensions/service-tunnels/status"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "self-allowlocal", allowLocal: false, ttlMs: TTL_MS })
      }).then((r) => r.json()).then((d) => {
        if (d.error) {
          setErr(d.error);
          onChanged();
        } else {
          setConfirmCountdown(CONFIRM_WINDOW);
          onChanged();
        }
      }).catch(() => setErr(String(t("services.error")))).finally(() => {
      });
      return;
    }
    setErr(null);
    setRestoredNotice(false);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowlocal", allowLocal: true, confirm: true })
    }).then((r) => r.json()).then((d) => {
      if (d.error) setErr(d.error);
      else onChanged();
    }).catch(() => setErr(String(t("services.error"))));
  };
  const confirmDisableNow = () => {
    setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowlocal", allowLocal: false, confirm: true })
    }).then(async (r) => {
      if (r.status === 403) {
        setBlockedHint(true);
        return null;
      }
      return r.json();
    }).then((d) => {
      if (d === null) return;
      if (d.error) setErr(d.error);
      else {
        setConfirmCountdown(null);
        onChanged();
      }
    }).catch(() => setErr(String(t("services.error"))));
  };
  const restoreNow = () => {
    setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowlocal", allowLocal: true, confirm: true })
    }).then(async (r) => {
      if (r.status === 403) {
        setBlockedHint(true);
        return null;
      }
      return r.json();
    }).then((d) => {
      if (d === null) return;
      if (d.error) setErr(d.error);
      else {
        setConfirmCountdown(null);
        setRestoredNotice(true);
        onChanged();
      }
    }).catch(() => setErr(String(t("services.error"))));
  };
  const [confirmCountdown, setConfirmCountdown] = useState(null);
  const [restoredNotice, setRestoredNotice] = useState(false);
  const [blockedHint, setBlockedHint] = useState(false);
  const [rejectDialog, setRejectDialog] = useState(false);
  const CONFIRM_WINDOW = 30;
  const TTL_MS = 3e4;
  useEffect(() => {
    if (confirmCountdown === null) return;
    if (confirmCountdown <= 0) {
      setConfirmCountdown(null);
      setRestoredNotice(true);
      onChanged();
      return;
    }
    const t2 = setTimeout(() => setConfirmCountdown((c2) => (c2 ?? 1) - 1), 1e3);
    return () => clearTimeout(t2);
  }, [confirmCountdown, onChanged]);
  const authEntries = (self?.urls ?? []).filter((u) => u.authEntry === true);
  const exposeUrls = (self?.urls ?? []).filter((u) => u.authEntry === true && !u.label.includes("allowHost"));
  useEffect(() => {
    if (!allowHostsTouched && (self?.allowHosts ?? []).length > 0) {
      setAllowHostsInput(self.allowHosts.join(" "));
    }
  }, [self, allowHostsTouched]);
  const saveAllowHosts = () => {
    setErr(null);
    const hosts = allowHostsInput.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowhosts", hosts })
    }).then((r) => r.json()).then((d) => {
      if (d.error) setErr(d.error);
      else onChanged();
    }).catch(() => setErr(String(t("services.error"))));
  };
  const [injectSel, setInjectSel] = useState([]);
  const doExpose = () => {
    setBusy(true);
    setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "self-expose",
        mode,
        provider: auth,
        // "none" 必须保留字符串,exposeSelf 判断 opts.auth === "none";传 undefined 会走默认 portal
        tunnel,
        tunnelParams,
        providerParams,
        ...injectSel.length ? { inject: injectSel } : {},
        ...loginInfoButton ? { loginInfoButton: true } : {}
      })
    }).then((r) => r.json()).then((d) => {
      if (d.error) setErr(d.error);
      else onChanged();
    }).catch(() => setErr(String(t("services.error")))).finally(() => setBusy(false));
  };
  const checkUsers = () => {
    if (!userManagersReady) {
      setErr(t("services.userCheckUnavailable"));
      return;
    }
    if (!userManagers.includes(auth)) {
      doExpose();
      return;
    }
    setChecking(true);
    setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "user-list", provider: auth, site: "pi-web" })
    }).then((r) => r.json()).then((d) => {
      if (d.error) {
        setErr(d.error);
        return;
      }
      const entry = (d.users ?? []).find((x) => x.provider === auth);
      const users = entry?.users ?? [];
      if (users.length === 0) {
        setNoUsers({ provider: auth, site: "pi-web" });
        return;
      }
      setUserConfirm({ provider: auth, site: "pi-web", users: users.map((u) => u.displayName || u.name) });
    }).catch(() => setErr(String(t("services.error")))).finally(() => setChecking(false));
  };
  const startExpose = () => {
    if (auth === "none") {
      setConfirmNone(true);
      return;
    }
    checkUsers();
  };
  const doStopTunnel = (name) => {
    setBusy(true);
    setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-stop-tunnel", name })
    }).then((r) => r.json()).then((d) => {
      if (d.error) setErr(d.error);
      else onChanged();
    }).catch(() => setErr(String(t("services.error")))).finally(() => setBusy(false));
  };
  const liveAllowHosts = allowHostsInput.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
  const tunnelParamStr = Object.entries(tunnelParams).map(([k, v]) => `tunnel.${k}=${v}`).join(",");
  const providerParamStr = Object.entries(providerParams).map(([k, v]) => `provider.${k}=${v}`).join(",");
  const envSnippet = `PI_WEB_EXPOSE="mode=${mode},auth=${auth}${mode !== "proxy" ? `,tunnel=${tunnel}` : ""}${tunnelParamStr ? `,${tunnelParamStr}` : ""}${providerParamStr ? `,${providerParamStr}` : ""}${liveAllowHosts.length ? `,allowHost=${liveAllowHosts.join(",allowHost=")}` : ""}"`;
  const copyEnv = () => {
    copyText(envSnippet).then(() => {
      setCopiedEnv(true);
      setTimeout(() => setCopiedEnv(false), 1500);
    }).catch(() => {
    });
  };
  return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 12 }, children: [
    /* @__PURE__ */ jsxs("div", { style: { border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }, children: [
      /* @__PURE__ */ jsxs("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 8 }, children: [
        t("services.selfAccessUrls"),
        " ",
        /* @__PURE__ */ jsxs("span", { style: { fontWeight: 400, color: "var(--text-dim)" }, children: [
          "\xB7 port ",
          self?.port ?? "?"
        ] })
      ] }),
      !self?.urls?.length ? /* @__PURE__ */ jsx("div", { style: { fontSize: 12, color: "var(--text-dim)" }, children: t("services.none") }) : /* @__PURE__ */ jsx("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: self.urls.map((u) => {
        const gated = !allowLocal && u.gated === true;
        return /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, opacity: gated ? 0.45 : 1 }, children: [
          /* @__PURE__ */ jsx("span", { style: { flexShrink: 0, color: "var(--text-dim)", width: 110 }, children: u.labelKey ? t(u.labelKey, u.labelParams) : u.label }),
          u.noAuth && /* @__PURE__ */ jsx(NoAuthBadge, { t }),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => {
                if (!gated) openOrDetail(u);
              },
              title: gated ? t("services.selfGatedHint") : u.url,
              disabled: gated,
              style: { flex: 1, textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: gated ? "var(--text-dim)" : "var(--accent)", cursor: gated ? "not-allowed" : "pointer", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: gated ? "line-through" : "none" },
              children: u.url
            }
          ),
          /* @__PURE__ */ jsx("button", { onClick: () => copy(`self-${u.url}`, u.url), style: { ...btn, padding: "3px 8px", flexShrink: 0 }, children: copiedKey === `self-${u.url}` ? "\u2713" : t("services.copy") }),
          u.tunnel && /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => doStopTunnel(u.tunnel),
              disabled: busy,
              title: t("services.selfStopTunnelHint"),
              style: { ...btn, padding: "3px 8px", flexShrink: 0, color: "var(--danger, #f87171)" },
              children: t("services.selfStopTunnel")
            }
          ),
          vhostStopName(u) && /* proxy 虚拟主机行:与 tunnel 行一致,外面直接可停止(移除 binding) */
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => onStopExpose(vhostStopName(u)),
              disabled: busy,
              title: t("services.selfStopVhostHint"),
              style: { ...btn, padding: "3px 8px", flexShrink: 0, color: "var(--danger, #f87171)" },
              children: t("services.exposeStop")
            }
          )
        ] }, u.url);
      }) })
    ] }),
    self?.unauthenticated && /* @__PURE__ */ jsxs("div", { style: { border: "1px solid var(--danger, #f87171)", borderRadius: 8, padding: "8px 10px", background: "rgba(248,113,113,0.08)", fontSize: 12, color: "var(--danger, #f87171)" }, children: [
      "\u{1F534} ",
      t("services.selfNoAuth"),
      " \u2014 ",
      t("services.selfNoAuthSummary")
    ] }),
    warnNonLoopback && /* @__PURE__ */ jsxs("div", { style: { border: "1px solid var(--danger, #f87171)", borderRadius: 8, padding: "8px 10px", background: "rgba(248,113,113,0.08)", fontSize: 12, color: "var(--danger, #f87171)" }, children: [
      "\u26A0 ",
      t("services.selfWarning")
    ] }),
    /* @__PURE__ */ jsxs("div", { style: { border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }, children: [
      /* @__PURE__ */ jsxs("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }, children: [
        t("services.selfExpose"),
        /* @__PURE__ */ jsxs("span", { style: { marginLeft: 8, fontSize: 11, fontWeight: 400, color: exposing ? self?.unauthenticated ? "var(--danger, #f87171)" : "#16a34a" : "var(--text-dim)" }, children: [
          "\u25CF ",
          exposing ? t("services.selfExposing") : t("services.selfNotExposing")
        ] })
      ] }),
      exposing && exposeUrls.length > 0 && /* @__PURE__ */ jsxs("div", { style: { border: self?.unauthenticated ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(22,163,74,0.3)", background: self?.unauthenticated ? "rgba(248,113,113,0.06)" : "rgba(22,163,74,0.06)", borderRadius: 6, padding: "8px 10px", marginBottom: 10 }, children: [
        /* @__PURE__ */ jsx("div", { style: { fontSize: 11, fontWeight: 600, color: self?.unauthenticated ? "var(--danger, #f87171)" : "#16a34a", marginBottom: 5 }, children: t("services.selfExposeUrls") }),
        /* @__PURE__ */ jsx("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: exposeUrls.map((u) => /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11 }, children: [
          /* @__PURE__ */ jsx("span", { style: { flexShrink: 0, color: "var(--text-dim)", width: 96 }, children: u.labelKey ? t(u.labelKey, u.labelParams) : u.label }),
          u.noAuth && /* @__PURE__ */ jsx(NoAuthBadge, { t }),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => openOrDetail(u),
              title: u.url,
              style: { flex: 1, textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
              children: u.url
            }
          ),
          /* @__PURE__ */ jsx("button", { onClick: () => copy(`self-expose-${u.url}`, u.url), style: { ...btn, padding: "3px 8px", flexShrink: 0 }, children: copiedKey === `self-expose-${u.url}` ? "\u2713" : t("services.copy") }),
          vhostStopName(u) && /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => onStopExpose(vhostStopName(u)),
              disabled: busy,
              title: t("services.selfStopVhostHint"),
              style: { ...btn, padding: "3px 8px", flexShrink: 0, color: "var(--danger, #f87171)" },
              children: t("services.exposeStop")
            }
          )
        ] }, u.url)) })
      ] }),
      /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }, children: t("services.selfExposeHint") }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }, children: [
        /* @__PURE__ */ jsxs("label", { style: { fontSize: 12, color: "var(--text-muted)" }, children: [
          t("services.selfMode"),
          ":",
          /* @__PURE__ */ jsxs("select", { value: mode, onChange: (e) => setMode(e.target.value), style: { ...select, marginLeft: 4 }, children: [
            /* @__PURE__ */ jsx("option", { value: "proxy", children: "proxy" }),
            /* @__PURE__ */ jsx("option", { value: "both", children: "both" }),
            /* @__PURE__ */ jsx("option", { value: "tunnel", children: "tunnel" })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("label", { style: { fontSize: 12, color: "var(--text-muted)" }, children: [
          t("services.selfAuth"),
          ":",
          /* @__PURE__ */ jsx("select", { value: auth, onChange: (e) => setAuth(e.target.value), style: { ...select, marginLeft: 4 }, children: (providers ?? ["none", "portal", "basic", "authelia"]).map((p) => /* @__PURE__ */ jsx("option", { value: p, children: providerDisplayLabel(p, t, authMetas) }, p)) })
        ] }),
        mode !== "proxy" && /* @__PURE__ */ jsxs("label", { style: { fontSize: 12, color: "var(--text-muted)" }, children: [
          t("services.selfTunnel"),
          ":",
          /* @__PURE__ */ jsx("select", { value: tunnel, onChange: (e) => setTunnel(e.target.value), style: { ...select, marginLeft: 4 }, children: [...Object.entries(tunnelSchemas ?? {})].filter(([p]) => !tunnelMetas?.[p]?.dangerous && p !== "command").sort((a, b) => {
            const fa = tunnelMetas?.[a[0]]?.favorite ? 1 : 0;
            const fb = tunnelMetas?.[b[0]]?.favorite ? 1 : 0;
            if (fa !== fb) return fb - fa;
            return a[1].length - b[1].length;
          }).map(([k]) => /* @__PURE__ */ jsxs("option", { value: k, children: [
            k,
            tunnelMetas?.[k]?.favorite ? " \u2605" : ""
          ] }, k)) })
        ] }),
        injectSources.length > 0 && /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }, children: [
          /* @__PURE__ */ jsxs("span", { style: { fontSize: 11, color: "var(--text-muted)" }, children: [
            "\u{1F9F0} ",
            t("services.injectJs")
          ] }),
          injectSources.map((s) => {
            const on = injectSel.includes(s.id);
            return /* @__PURE__ */ jsxs("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer", color: on ? "var(--text)" : "var(--text-dim)" }, title: s.description ?? "", children: [
              /* @__PURE__ */ jsx("input", { type: "checkbox", checked: on, onChange: (e) => setInjectSel((prev) => e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)), style: { accentColor: "var(--accent)", cursor: "pointer" } }),
              s.label
            ] }, s.id);
          })
        ] }),
        /* @__PURE__ */ jsx("button", { onClick: startExpose, disabled: busy || checking, style: { ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600 }, children: busy ? "\u2026" : t("services.selfExposeBtn") })
      ] }),
      mode !== "proxy" && tunnelSchemas?.[tunnel] && /* @__PURE__ */ jsxs("div", { style: { marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }, children: [
        /* @__PURE__ */ jsxs("div", { style: { fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }, children: [
          t("services.tunnelParams"),
          tunnelMetas?.[tunnel]?.favorite && /* @__PURE__ */ jsx("span", { style: { marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "var(--accent)", color: "#fff", fontSize: 9, fontWeight: 600 }, children: t("services.recommended") })
        ] }),
        /* @__PURE__ */ jsx(SchemaForm, { specs: tunnelSchemas[tunnel], values: tunnelParams, onChange: (k, v) => setTunnelParams((prev) => ({ ...prev, [k]: v })), t })
      ] }),
      auth && auth !== "none" && authSchemas?.[auth] && authSchemas[auth].length > 0 && /* @__PURE__ */ jsxs("div", { style: { marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }, children: [
        /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }, children: t("services.authParams") }),
        /* @__PURE__ */ jsx(SchemaForm, { specs: authSchemas[auth], values: providerParams, onChange: (k, v) => setProviderParams((prev) => ({ ...prev, [k]: v })), t })
      ] }),
      err && /* @__PURE__ */ jsx("div", { style: { fontSize: 12, color: "var(--danger, #f87171)", marginTop: 8 }, children: err })
    ] }),
    /* @__PURE__ */ jsxs("label", { style: { display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }, title: t("services.selfAllowLocalHint"), children: [
      /* @__PURE__ */ jsx(
        "input",
        {
          type: "checkbox",
          checked: allowLocal,
          onChange: (e) => toggleAllowLocal(e.target.checked),
          style: { accentColor: "var(--accent)", cursor: "pointer", marginTop: 2 }
        }
      ),
      /* @__PURE__ */ jsxs("span", { style: { fontSize: 12, color: "var(--text)" }, children: [
        /* @__PURE__ */ jsx("b", { children: t("services.selfAllowLocal") }),
        /* @__PURE__ */ jsx("span", { style: { display: "block", color: "var(--text-dim)", fontSize: 11, marginTop: 2 }, children: t("services.selfAllowLocalHint") }),
        !exposing && !allowLocal && /* @__PURE__ */ jsxs("span", { style: { display: "block", color: "#d97706", fontSize: 11, marginTop: 4 }, children: [
          "\u26A0 ",
          t("services.selfNotExposingHint")
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { style: { border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }, children: [
      /* @__PURE__ */ jsx("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }, children: t("services.selfAllowHosts") }),
      /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }, children: t("services.selfAllowHostsHint") }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 6 }, children: [
        /* @__PURE__ */ jsx(
          "input",
          {
            value: allowHostsInput,
            onChange: (e) => {
              setAllowHostsInput(e.target.value);
              setAllowHostsTouched(true);
            },
            placeholder: "backup.example.com vpn.example.com",
            style: { flex: 1, padding: "4px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }
          }
        ),
        /* @__PURE__ */ jsx("button", { onClick: saveAllowHosts, style: { ...btn, flexShrink: 0 }, children: t("services.selfAllowHostsSave") })
      ] }),
      (self?.allowHosts ?? []).length > 0 && /* @__PURE__ */ jsxs("div", { style: { fontSize: 11, color: "var(--text-dim)", marginTop: 6 }, children: [
        t("services.selfAllowHostsCurrent"),
        ": ",
        /* @__PURE__ */ jsx("span", { style: { fontFamily: "var(--font-mono)" }, children: self.allowHosts.join(", ") })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { style: { border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }, children: [
      /* @__PURE__ */ jsx("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }, children: t("services.selfEnvHint") }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 6, alignItems: "center" }, children: [
        /* @__PURE__ */ jsx("code", { style: { flex: 1, fontFamily: "var(--font-mono)", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, padding: "5px 8px", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: envSnippet }),
        /* @__PURE__ */ jsx("button", { onClick: copyEnv, style: { ...btn, flexShrink: 0 }, children: copiedEnv ? "\u2713" : t("services.copy") })
      ] }),
      /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", marginTop: 6 }, children: t("services.selfEnvNote") })
    ] }),
    confirmCountdown !== null && /* @__PURE__ */ jsx("div", { style: { position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ jsxs("div", { style: { width: 520, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }, children: [
      /* @__PURE__ */ jsxs("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--danger, #f87171)", marginBottom: 8 }, children: [
        "\u26A0 ",
        t("services.lockoutTitle", { ttl: String(TTL_MS / 1e3) })
      ] }),
      /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }, children: t("services.lockoutCountdown", { window: String(CONFIRM_WINDOW), ttl: String(TTL_MS / 1e3) }) }),
      /* @__PURE__ */ jsxs("div", { style: { marginTop: 10 }, children: [
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }, children: [
          /* @__PURE__ */ jsxs("span", { style: { fontSize: 20, fontWeight: 700, color: confirmCountdown <= 10 ? "var(--danger, #f87171)" : "var(--text)", fontVariantNumeric: "tabular-nums", minWidth: 40 }, children: [
            confirmCountdown,
            "s"
          ] }),
          /* @__PURE__ */ jsx("div", { style: { flex: 1, height: 6, borderRadius: 3, background: "var(--bg-hover)", overflow: "hidden" }, children: /* @__PURE__ */ jsx("div", { style: { height: "100%", width: `${confirmCountdown / CONFIRM_WINDOW * 100}%`, background: confirmCountdown <= 10 ? "var(--danger, #f87171)" : "var(--accent)", transition: "width 1s linear" } }) })
        ] }),
        /* @__PURE__ */ jsx("div", { style: { fontSize: 10, color: "var(--text-dim)" }, children: t("services.lockoutAutoRestore") })
      ] }),
      blockedHint && /* @__PURE__ */ jsx("div", { style: { marginTop: 8, padding: "8px 10px", borderRadius: 6, background: "rgba(217,119,6,0.1)", border: "1px solid rgba(217,119,6,0.35)", fontSize: 11, color: "#d97706" }, children: t("services.lockoutBlockedHint", { ttl: String(TTL_MS / 1e3) }) }),
      /* @__PURE__ */ jsxs("div", { style: { marginTop: 10 }, children: [
        /* @__PURE__ */ jsx("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }, children: t("services.lockoutStillWorks") }),
        authEntries.length > 0 && /* @__PURE__ */ jsx("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 6 }, children: authEntries.map((u) => /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11 }, children: [
          /* @__PURE__ */ jsx("span", { style: { color: "var(--text-dim)", flexShrink: 0 }, children: u.labelKey ? t(u.labelKey, u.labelParams) : u.label }),
          /* @__PURE__ */ jsx("span", { style: { flex: 1, fontFamily: "var(--font-mono)", overflowWrap: "anywhere", color: "var(--text)" }, children: u.url }),
          /* @__PURE__ */ jsx("button", { onClick: () => openInNewTab(u.url), style: { ...btn, padding: "3px 10px", flexShrink: 0, color: "var(--accent)" }, children: t("services.lockoutVerify") })
        ] }, u.url)) })
      ] }),
      /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, marginTop: 12, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }, children: [
        /* @__PURE__ */ jsx("button", { onClick: restoreNow, style: { ...btn, flexShrink: 0 }, children: t("services.lockoutRestore") }),
        /* @__PURE__ */ jsx("span", { style: { flex: 1 } }),
        /* @__PURE__ */ jsx(
          "button",
          {
            onClick: confirmDisableNow,
            style: { ...btn, background: "var(--danger, #f87171)", borderStyle: "none", color: "#fff", fontWeight: 600 },
            children: t("services.lockoutConfirm")
          }
        )
      ] })
    ] }) }),
    rejectDialog && /* @__PURE__ */ jsx("div", { style: { position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }, onClick: () => setRejectDialog(false), children: /* @__PURE__ */ jsxs("div", { onClick: (e) => e.stopPropagation(), style: { width: 460, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }, children: [
      /* @__PURE__ */ jsxs("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--danger, #f87171)", marginBottom: 8 }, children: [
        "\u26A0 ",
        t("services.lockoutNoEntryTitle")
      ] }),
      /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }, children: t("services.lockoutNoEntry") }),
      /* @__PURE__ */ jsx("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 12 }, children: /* @__PURE__ */ jsx("button", { onClick: () => setRejectDialog(false), style: { ...btn }, children: t("services.close") }) })
    ] }) }),
    restoredNotice && /* @__PURE__ */ jsxs("div", { style: { marginTop: 6, padding: "6px 10px", borderRadius: 6, background: "rgba(22,163,74,0.1)", border: "1px solid rgba(22,163,74,0.35)", fontSize: 11, color: "#16a34a" }, children: [
      "\u2713 ",
      t("services.lockoutRestored")
    ] }),
    confirmNone && /* @__PURE__ */ jsx(
      ConfirmDialog,
      {
        title: t("services.confirmNoAuthTitle"),
        body: t("services.confirmNoAuthBodySelf"),
        confirmLabel: t("services.exposeConfirm"),
        cancelLabel: t("services.exposeAbort"),
        onConfirm: () => {
          setConfirmNone(false);
          doExpose(exposeOverrideRef.current);
          exposeOverrideRef.current = null;
          ;
        },
        onCancel: () => setConfirmNone(false)
      }
    ),
    noUsers && /* @__PURE__ */ jsx(
      ConfirmDialog,
      {
        title: t("services.confirmNoUsersTitle"),
        body: t("services.confirmNoUsersBody", { provider: noUsers.provider, site: noUsers.site }),
        confirmLabel: t("services.confirmNoUsersGo"),
        cancelLabel: t("services.exposeAbort"),
        onConfirm: () => {
          setNoUsers(null);
          onGoManageUsers();
        },
        onCancel: () => setNoUsers(null)
      }
    ),
    userConfirm && /* @__PURE__ */ jsx(
      ConfirmDialog,
      {
        title: t("services.confirmUsersTitle"),
        body: /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("div", { style: { fontSize: 11, lineHeight: 1.7 }, children: t("services.confirmUsersBody", { provider: userConfirm.provider, site: userConfirm.site }) }),
          /* @__PURE__ */ jsx("ul", { style: { margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text)" }, children: userConfirm.users.map((u) => /* @__PURE__ */ jsx("li", { children: u }, u)) })
        ] }),
        confirmLabel: t("services.confirmUsersConfirm"),
        cancelLabel: t("services.exposeAbort"),
        onConfirm: () => {
          setUserConfirm(null);
          doExpose(exposeOverrideRef.current);
          exposeOverrideRef.current = null;
          ;
        },
        onCancel: () => setUserConfirm(null)
      }
    )
  ] });
}

// client/src/SelfExposeAlert.tsx
var LOAD_DELAY_MS = 1e3;
var RESUME_DELAY_MS = 500;
function SelfExposeAlert({ sessionLoadedKey, onOpenServices }) {
  const { t } = useI18n();
  const [state, setState] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const resumeTimerRef = useRef(null);
  const load = useCallback(() => {
    fetch(apiUrl("/api/extensions/service-tunnels/status?self-only=1")).then((r) => r.json()).then((d) => {
      if (d.error || !d.self) {
        setState(null);
        return;
      }
      setState({ exposing: Boolean(d.self.exposing), unauthenticated: Boolean(d.self.unauthenticated) });
    }).catch(() => setState(null));
  }, []);
  useEffect(() => {
    const timer = setTimeout(load, LOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [sessionLoadedKey, load]);
  useEffect(() => {
    const schedule = () => {
      if (document.visibilityState !== "visible") return;
      if (resumeTimerRef.current) window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = window.setTimeout(load, RESUME_DELAY_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule();
    };
    window.addEventListener("focus", schedule);
    window.addEventListener("online", schedule);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", schedule);
      window.removeEventListener("online", schedule);
      document.removeEventListener("visibilitychange", onVisibility);
      if (resumeTimerRef.current) window.clearTimeout(resumeTimerRef.current);
    };
  }, [load]);
  const show = Boolean(state?.exposing && state.unauthenticated && !dismissed);
  const stopNow = () => {
    setStopping(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-stop" })
    }).then((r) => r.json()).then((d) => {
      if (d.error) return;
      setState((prev) => prev ? { ...prev, exposing: false, unauthenticated: false } : prev);
      setReasonOpen(false);
    }).catch(() => {
    }).finally(() => setStopping(false));
  };
  if (!show) return null;
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsxs(
      "div",
      {
        onClick: () => setReasonOpen(true),
        role: "alert",
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          flexShrink: 0,
          background: "rgba(248,113,113,0.12)",
          borderBottom: "1px solid rgba(248,113,113,0.5)",
          fontSize: 12,
          color: "var(--danger, #f87171)",
          cursor: "pointer"
        },
        children: [
          /* @__PURE__ */ jsx("span", { style: { fontSize: 13, flexShrink: 0 }, children: "\u{1F534}" }),
          /* @__PURE__ */ jsx("b", { style: { flexShrink: 0 }, children: t("services.selfNoAuth") }),
          /* @__PURE__ */ jsx("span", { style: { color: "#fca5a5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }, children: t("services.selfNoAuthSummary") }),
          /* @__PURE__ */ jsx("span", { style: { flex: 1 } }),
          /* @__PURE__ */ jsxs("span", { style: { flexShrink: 0, fontWeight: 600 }, children: [
            t("services.selfNoAuthReason"),
            " \u203A"
          ] }),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: (e) => {
                e.stopPropagation();
                setDismissed(true);
              },
              title: t("services.selfNoAuthDismiss"),
              "aria-label": t("services.selfNoAuthDismiss"),
              style: { flexShrink: 0, background: "none", border: "none", color: "var(--danger, #f87171)", cursor: "pointer", fontSize: 14, padding: "0 2px" },
              children: "\xD7"
            }
          )
        ]
      }
    ),
    reasonOpen && /* @__PURE__ */ jsx(
      "div",
      {
        style: { position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" },
        onClick: () => setReasonOpen(false),
        children: /* @__PURE__ */ jsxs(
          "div",
          {
            onClick: (e) => e.stopPropagation(),
            style: { width: 480, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" },
            children: [
              /* @__PURE__ */ jsxs("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--danger, #f87171)", marginBottom: 8 }, children: [
                "\u{1F534} ",
                t("services.selfNoAuth")
              ] }),
              /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }, children: t("services.selfNoAuthBody") }),
              /* @__PURE__ */ jsx("div", { style: { fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7, marginTop: 8 }, children: t("services.selfNoAuthSuggest").split("\n").map((line, i) => /* @__PURE__ */ jsxs("div", { children: [
                "\u2022 ",
                line
              ] }, i)) }),
              /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }, children: [
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    onClick: () => {
                      setReasonOpen(false);
                      onOpenServices();
                    },
                    style: { padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 },
                    children: t("services.selfNoAuthOpen")
                  }
                ),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    onClick: stopNow,
                    disabled: stopping,
                    style: { padding: "5px 14px", background: "#dc2626", border: "none", borderRadius: 6, color: "#fff", cursor: stopping ? "default" : "pointer", fontSize: 12, fontWeight: 600 },
                    children: stopping ? "\u2026" : t("services.selfNoAuthStop")
                  }
                ),
                /* @__PURE__ */ jsx(
                  "button",
                  {
                    onClick: () => {
                      setReasonOpen(false);
                      setDismissed(true);
                    },
                    style: { padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 },
                    children: t("services.selfNoAuthDismiss")
                  }
                )
              ] })
            ]
          }
        )
      }
    )
  ] });
}

// client/src/entry.ts
var dialogOpen = false;
var initialTab = "ports";
var dialogListeners = /* @__PURE__ */ new Set();
function setDialog(v, tab = initialTab) {
  dialogOpen = v;
  if (v) initialTab = tab;
  for (const l of dialogListeners) l();
}
function openDialog(tab = "ports") {
  setDialog(true, tab);
}
var pulse = 0;
var pulseListeners = /* @__PURE__ */ new Set();
var g = globalThis;
function startPulse() {
  if (g.__stPulseId) clearInterval(g.__stPulseId);
  g.__stPulseId = setInterval(() => {
    pulse++;
    for (const l of pulseListeners) l();
  }, 1e4);
}
function register(ctx) {
  __setCtx(ctx);
  const { h, useState: useState2, useEffect: useEffect2 } = ctx;
  function usePulse() {
    const [n, setN] = useState2(pulse);
    useEffect2(() => {
      const l = () => setN((v) => (v + 1) % 1e9);
      pulseListeners.add(l);
      return () => {
        pulseListeners.delete(l);
      };
    }, []);
    return n;
  }
  function ToolbarButton() {
    const [, force] = useState2(0);
    useEffect2(() => {
      const l = () => force((n) => (n + 1) % 1e9);
      dialogListeners.add(l);
      return () => {
        dialogListeners.delete(l);
      };
    }, []);
    return h(
      "button",
      {
        type: "button",
        title: "\u670D\u52A1\u7AEF\u53E3\u4E0E\u96A7\u9053\uFF08\u53D1\u73B0 / \u66B4\u9732 / \u8BA4\u8BC1 / \u81EA\u66B4\u9732\uFF09",
        "aria-label": "\u670D\u52A1\u7AEF\u53E3",
        "aria-haspopup": "dialog",
        "aria-expanded": dialogOpen,
        onClick: () => openDialog("ports"),
        onMouseEnter: (e) => {
          if (!dialogOpen) e.currentTarget.style.color = "var(--text)";
        },
        onMouseLeave: (e) => {
          if (!dialogOpen) e.currentTarget.style.color = "var(--text-muted)";
        },
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 36,
          height: 36,
          padding: 0,
          background: dialogOpen ? "var(--bg-selected)" : "none",
          border: "none",
          borderRight: "1px solid var(--border)",
          color: dialogOpen ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          flexShrink: 0,
          fontSize: 16,
          lineHeight: 1,
          transition: "color 0.12s"
        }
      },
      h(
        "svg",
        {
          width: 16,
          height: 16,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        },
        h("circle", { key: "c1", cx: 12, cy: 12, r: 10 }),
        h("line", { key: "l1", x1: 2, y1: 12, x2: 22, y2: 12 }),
        h("path", { key: "p1", d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" })
      )
    );
  }
  function DialogsSlot() {
    const [, force] = useState2(0);
    useEffect2(() => {
      const l = () => force((n) => (n + 1) % 1e9);
      dialogListeners.add(l);
      return () => {
        dialogListeners.delete(l);
      };
    }, []);
    if (!dialogOpen) return null;
    return h(ServicesDialog, {
      onClose: () => setDialog(false),
      onOpenFile: (filePath, fileName) => openFileInHost(filePath, fileName),
      initialTab
    });
  }
  function BannersSlot() {
    usePulse();
    return h(SelfExposeAlert, {
      sessionLoadedKey: `st:${pulse}`,
      onOpenServices: () => openDialog("self")
    });
  }
  ctx.registerItems("toolbar", [{ id: "ports", render: ToolbarButton, meta: { label: "\u670D\u52A1\u7AEF\u53E3" } }]);
  ctx.registerItems("dialogs", [{ id: "ports", render: DialogsSlot }]);
  ctx.registerItems("banners", [{ id: "self-expose-alert", render: BannersSlot }]);
  startPulse();
}
export {
  register as default
};
