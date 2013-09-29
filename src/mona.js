"use strict";

/**
 * Parser execution api
 * @namespace api
 */

var VERSION = "0.6.0";

/**
 * Executes a parser and returns the result.
 *
 * @param {Function} parser - The parser to execute.
 * @param {String} string - String to parse.
 * @param {Object} [opts] - Options object.
 * @param {Boolean} [opts.throwOnError=true] - If truthy, throws a ParserError
 *                                             if the parser fails and returns
 *                                             ParserState instead of its value.
 * @param {String} [opts.fileName] - filename to use for error messages.
 * @returns {value|api.ParserError}
 * @memberof api
 */
function parse(parser, string, opts) {
  opts = opts || {};
  opts.throwOnError = typeof opts.throwOnError === "undefined" ?
    true : opts.throwOnError;
  if (!opts.allowTrailing) {
    parser = followedBy(parser, eof());
  }
  var parserState = parser(
    new ParserState(undefined,
                    string,
                    0,
                    opts.userState,
                    opts.position || new SourcePosition(opts.fileName),
                    false));
  if (parserState.failed && opts.throwOnError) {
    throw parserState.error;
  } else if (parserState.failed && !opts.throwOnError) {
    return parserState.error;
  } else if (!parserState.failed && !opts.throwOnError) {
    return parserState;
  } else if (opts.returnState) {
    return parserState;
  } else {
    return parserState.value;
  }
}

/**
 * Executes a parser asynchronously, returning an object that can be used to
 * manage the parser state. Unless the parser given tries to match eof(),
 * parsing will continue until the parser's done() function is called.
 *
 * @param {Function} parser - The parser to execute.
 * @param {AsyncParserCallback} callback - node-style 2-arg callback executed
 *                                         once per successful application of
 *                                         `parser`.
 * @param {Object} [opts] - Options object.
 * @param {String} [opts.fileName] - filename to use for error messages.
 * @returns {AsyncParserHandle}
 * @memberof api
 */
function parseAsync(parser, callback, opts) {
  opts = copy(opts || {});
  // Force the matter in case someone gets clever.
  opts.throwOnError = true;
  opts.returnState = true;
  opts.allowTrailing = true;
  var done = false,
      buffer = "";
  function exec() {
    if (done && !buffer.length) {
      return false;
    }
    var res;
    try {
      res = parse(collect(parser, {min: 1}), buffer, opts);
      opts.position = res.position;
      buffer = res.input.slice(res.offset);
    } catch (e) {
      if (!e.wasEof || done) {
        callback(e);
      }
      return false;
    }
    res.value.forEach(function(val) {
      callback(null, val);
    });
    return true;
  }
  function errIfDone(cb) {
    return function() {
      if (done) {
        throw new Error("AsyncParser closed");
      } else {
        return cb.apply(null, arguments);
      }
    };
  }
  var handle = {
    done: errIfDone(function() {
      done = true;
      buffer = "";
      while(exec()){}
      return handle;
    }),
    data: errIfDone(function(data) {
      buffer += data;
      while(exec()){}
      return handle;
    }),
    error: errIfDone(function(error) {
      done = true;
      callback(error);
      return handle;
    })
  };
  return handle;
}

/**
 * Represents a source location.
 * @typedef {Object} SourcePosition
 * @property {String} name - Optional sourcefile name.
 * @property {integer} line - Line number, starting from 1.
 * @property {integer} column - Column number in the line, starting from 1.
 * @memberof api
 */
function SourcePosition(name, line, column) {
  this.name = name;
  this.line = line || 1;
  this.column = column || 0;
}

/**
 * Information about a parsing failure.
 * @typedef {Object} ParserError
 * @property {api.SourcePosition} position - Source position for the error.
 * @property {Array} messages - Array containing relevant error messages.
 * @property {String} type - The type of parsing error.
 * @memberof api
 */
function ParserError(pos, messages, type, wasEof) {
  if (Error.captureStackTrace) {
    // For pretty-printing errors on node.
    Error.captureStackTrace(this, this);
  }
  this.position = pos;
  this.messages = messages;
  this.type = type;
  this.wasEof = wasEof;
  this.message = ("(line "+ this.position.line +
                  ", column "+this.position.column+") "+
                  this.messages.join("\n"));
}
ParserError.prototype = new Error();
ParserError.prototype.constructor = ParserError;
ParserError.prototype.name = "ParserError";


/**
 * Core parsers
 *
 * @namespace core
 */

/**
 * A function accepting parserState as input that transforms it and returns a
 * new parserState.
 * @callback {Function} Parser
 * @param {ParserState} state - Current parser state.
 * @returns {ParserState} state' - Transformed parser state.
 * @memberof core
 */

/**
 * Returns a parser that always succeeds without consuming input.
 *
 * @param [val=undefined] - value to use as this parser's value.
 * @returns {core.Parser}
 * @memberof core
 */
function value(val) {
  return function(parserState) {
    var newState = copy(parserState);
    newState.value = val;
    return newState;
  };
}

/**
 * Returns a parser that calls `fun` on the value resulting from running
 * `parser` on the current parsing state. Fails without executing `fun` if
 * `parser` fails.
 *
 * @param {core.Parser} parser - The parser to execute.
 * @param {Function} fun - Function called with the resulting value of
 *                         `parser`. Must return a parser.
 * @returns {core.Parser}
 * @memberof core
 */
function bind(parser, fun) {
  return function(parserState) {
    var newParserState = parser(parserState);
    if (!(newParserState instanceof ParserState)) {
      throw new Error("Parsers must return a parser state object");
    }
    if (newParserState.failed) {
      return newParserState;
    } else {
      return fun(newParserState.value)(newParserState);
    }
  };
}

/**
 * Returns a parser that always fails without consuming input. Automatically
 * includes the line and column positions in the final ParserError.
 *
 * @param {String} msg - Message to report with the failure.
 * @param {String} type - A type to apply to the ParserError.
 * @returns {core.Parser}
 * @memberof core
 */
function fail(msg, type) {
  msg = msg || "parser error";
  type = type || "failure";
  return function(parserState) {
    parserState = copy(parserState);
    parserState.failed = true;
    var newError = new ParserError(parserState.position, [msg],
                                   type, type === "eof");
    parserState.error = mergeErrors(parserState.error, newError);
    return parserState;
  };
}

/**
 * Returns a parser that will label a `parser` failure by replacing its error
 * messages with `msg`.
 *
 * @param {core.Parser} parser - Parser whose errors to replace.
 * @param {String} msg - Error message to replace errors with.
 * @returns {core.Parser}
 * @memberof core
 */
function label(parser, msg) {
  return function(parserState) {
    var newState = parser(parserState);
    if (newState.failed) {
      newState = copy(newState);
      newState.error = new ParserError(newState.error.position,
                                       ["expected "+msg],
                                       "expectation",
                                       newState.error.wasEof);
    }
    return newState;
  };
}

/**
 * Returns a parser that consumes a single item from the input, or fails with an
 * unexpected eof error if there is no input left.
 *
 * @param {integer} [count=1] - number of tokens to consume. Must be > 0.
 * @returns {core.Parser}
 * @memberof core
 */
function token(count) {
  count = count || 1; // force 0 to 1, as well.
  return function(parserState) {
    var input = parserState.input,
        offset = parserState.offset,
        newOffset = offset + count,
        newParserState = copy(parserState),
        newPosition = copy(parserState.position);
    newParserState.position = newPosition;
    for (var i = offset; i < newOffset && input.length >= i; i++) {
      if (input.charAt(i) === "\n") {
        newPosition.column = 0;
        newPosition.line += 1;
      } else {
        newPosition.column += 1;
      }
    }
    newParserState.offset = newOffset;
    if (input.length >= newOffset) {
      newParserState.value = input.slice(offset, newOffset);
      return newParserState;
    } else {
      return fail("unexpected eof", "eof")(newParserState);
    }
  };
}

/**
 * Returns a parser that succeeds with a value of `true` if there is no more
 * input to consume.
 *
 * @returns {core.Parser}
 * @memberof core
 */
function eof() {
  return function(parserState) {
    if (parserState.input.length === parserState.offset) {
      return value(true)(parserState);
    } else {
      return fail("expected end of input", "expectation")(parserState);
    }
  };
}

/**
 * Delays calling of a parser constructor function until parse-time. Useful for
 * recursive parsers that would otherwise blow the stack at construction time.
 *
 * @param {Function} constructor - A function that returns a core.Parser.
 * @param {...Any} args - Arguments to apply to the constructor.
 * @returns {core.Parser}
 * @memberof core
 */
function delay(constructor) {
  var args = [].slice.call(arguments, 1);
  return function(parserState) {
    return constructor.apply(null, args)(parserState);
  };
}

/**
 * Debugger parser that logs the ParserState with a tag.
 *
 * @param {core.Parser} parser - Parser to wrap.
 * @param {String} tag - Tag to use when logging messages.
 * @param {String} [level="log"] - 'log', 'info', 'debug', 'warn', 'error'.
 * @returns {core.Parser}
 * @memberof core
 */
function log(parser, tag, level) {
  level = level || "log";
  return function(parserState) {
    var newParserState = parser(parserState);
    console[level](tag+" :: ", parserState, " => ", newParserState);
    return newParserState;
  };
}

/**
 * Returns a parser that transforms the resulting value of a successful
 * application of its given parser. This function is a lot like `bind`, except
 * it always succeeds if its parser succeeds, and is expected to return a
 * transformed value, instead of another parser.
 *
 * @param {Function} transformer - Function called on `parser`'s value. Its
 *                                 return value will be used as the `map`
 *                                 parser's value.
 * @param {core.Parser} parser - Parser that will yield the input value.
 * @returns {core.Parser}
 * @memberof core
 */
function map(transformer, parser) {
  return bind(parser, function(result) {
    return value(transformer(result));
  });
}

/**
 * Returns a parser that returns an object with a single key whose value is the
 * result of the given parser.
 *
 * @param {core.Parser} parser - Parser whose value will be tagged.
 * @param {String} tag - String to use as the object's key.
 * @returns {core.Parser}
 * @memberof core
 */
function tag(parser, key) {
  return map(function(x) { var ret = {}; ret[key] = x; return ret; }, parser);
}

/**
 * Returns a parser that runs a given parser without consuming input, while
 * still returning a success or failure.
 *
 * @param {core.Parser} test - Parser to execute.
 * @returns {core.Parser}
 * @memberof core
 */
function lookAhead(parser) {
  return function(parserState) {
    var ret = parser(parserState),
        newState = copy(parserState);
    newState.value = ret.value;
    return newState;
  };
}

/**
 * Returns a parser that succeeds with the next token as its value if
 * `predicate` returns a truthy value when called on the token.
 *
 * @param {Function} predicate - Tests a token.
 * @returns {core.Parser}
 * @memberof core
 */
function is(predicate) {
  return bind(token(), function(tok) {
    return (predicate(tok)) ? value(tok) : fail();
  });
}

/**
 * Returns a parser that succeeds with the next token as its value if
 * `predicate` returns a falsy value when called on the token.
 *
 * @param {Function} predicate - Tests a token.
 * @returns {core.Parser}
 * @memberof core
 */
function isNot(predicate) {
  return is(function(x) { return !predicate(x); });
}

/**
 * Parser combinators for higher-order interaction between parsers.
 *
 * @namespace combinators
 */

/**
 * Returns a parser that succeeds if all the parsers given to it succeed. The
 * returned parser uses the value of the last successful parser.
 *
 * @param {...core.Parser} parsers - One or more parsers to execute.
 * @returns {core.Parser}
 * @memberof combinators
 */
function and(firstParser) {
  var moreParsers = [].slice.call(arguments, 1);
  if (!firstParser) {
    throw new Error("and() requires at least one parser");
  }
  return bind(firstParser, function(result) {
    return moreParsers.length ?
      and.apply(null, moreParsers) :
      value(result);
  });
}

/**
 * Returns a parser that succeeds if one of the parsers given to it
 * suceeds. Uses the value of the first successful parser.
 *
 * @param {...core.Parser} parsers - One or more parsers to execute.
 * @param {String} [label] - Label to replace the full message with.
 * @returns {core.Parser}
 * @memberof combinators
 */
function or() {
  var errors = [];
  function orHelper() {
    var parsers = [].slice.call(arguments);
    return function(parserState) {
      var res = parsers[0](parserState);
      if (res.failed) {
        errors.push(res.error);
      }
      if (res.failed && parsers[1]) {
        return orHelper.apply(null, parsers.slice(1))(parserState);
      } else if (res.failed) {
        var finalState = copy(res);
        finalState.error = errors.reduce(function(err1, err2) {
          return mergeErrors(err1, err2);
        });
        return finalState;
      } else {
        return res;
      }
    };
  }
  var labelMsg = (typeof arguments[arguments.length-1] === "string" &&
                  arguments[arguments.length-1]),
      args = labelMsg ?
        [].slice.call(arguments, 0, arguments.length-1) : arguments,
      parser = orHelper.apply(null, args);
  if (labelMsg) {
    return label(parser, labelMsg);
  } else {
    return parser;
  }
}

/**
 * Returns a parser that returns the result of `parser` if it succeeds,
 * otherwise succeeds with a value of `undefined` without consuming input.
 *
 * @param {core.Parser} parser - Parser to try.
 * @returns {core.Parser}
 * @memberof combinators
 */
function maybe(parser) {
  return or(parser, value());
}

/**
 * Returns a parser that succeeds if `parser` fails. Does not consume.
 *
 * @param {core.Parser} parser - parser to test.
 * @returns {core.Parser}
 * @memberof combinators
 */
function not(parser) {
  return function(parserState) {
    return parser(parserState).failed ?
      value(true)(parserState) :
      fail("expected parser to fail", "expectation")(parserState);
  };
}

/**
 * Returns a parser that works like `and`, but fails if the first parser given
 * to it succeeds. Like `and`, it returns the value of the last successful
 * parser.
 *
 * @param {core.Parser} notParser - If this parser succeeds, `unless` will fail.
 * @param {...core.Parser} moreParsers - Rest of the parses to test.
 * @returns {core.Parser}
 * @memberof combinators
 */
function unless(parser) {
  var moreParsers = [].slice.call(arguments, 1);
  return and.apply(null, [not(parser)].concat(moreParsers));
}

/**
 * Returns a parser that will execute `fun` while handling the parserState
 * internally, allowing the body of `fun` to be written sequentially. The
 * purpose of this parser is to simulate `do` notation and prevent the need for
 * heavily-nested `bind` calls.
 *
 * The `fun` callback will receive a function `s` which should be called with
 * each parser that will be executed, which will update the internal
 * parserState. The return value of the callback must be a parser.
 *
 * If any of the parsers fail, sequence will exit immediately, and the entire
 * sequence will fail with that parser's reason.
 *
 * @param {SequenceFn} fun - A sequence callback function to execute.
 * @returns {core.Parser}
 * @memberof combinators
 *
 * @example
 * mona.sequence(function(s) {
 *  var x = s(mona.token());
 *  var y = s(mona.string('b'));
 *  return mona.value(x+y);
 * });
 */
function sequence(fun) {
  return function(parserState) {
    var state = parserState, failwhale = {};
    function s(parser) {
      state = parser(state);
      if (state.failed) {
        throw failwhale;
      } else {
        return state.value;
      }
    }
    try {
      var ret = fun(s);
      if (typeof ret !== "function") {
        throw new Error("sequence function must return a parser");
      }
      var newState = ret(state);
      if (!(newState instanceof ParserState)) {
        throw new Error("sequence function must return a parser");
      }
      return newState;
    } catch(x) {
      if (x === failwhale) {
        return state;
      } else {
        throw x;
      }
    }
  };
}

/**
 * Called by `sequence` to handle sequential syntax for parsing. Called with an
 * `s()` function that must be called each time a parser should be applied. The
 * `s()` function will return the unwrapped value returned by the parser. If any
 * of the `s()` calls fail, this callback will exit with an appropriate failure
 * message, and none of the subsequent code will execute.
 *
 * Note that this callback may be called multiple times during parsing, and many
 * of those calls might partially fail, so side-effects should be done with
 * care.
 *
 * A `sequence` callback *must* return a `core.Parser`.
 *
 * @callback {Function} SequenceFn
 * @param {Function} s - Sequencing function. Must be wrapped around a parser.
 * @returns {core.Parser} parser - The final parser to apply before resolving
 *                                 `sequence`.
 * @memberof combinators
 */


/**
 * Returns a parser that returns the result of its first parser if it succeeds,
 * but fails if any of the following parsers fail.
 *
 * @param {core.Parser} parser - The value of this parser is returned if it
 *                               succeeds.
 * @param {...core.Parser} moreParsers - These parsers must succeed in order for
 *                                       `followedBy` to succeed.
 * @returns {core.Parser}
 * @memberof combinators
 */
function followedBy(parser) {
  var parsers = [].slice.call(arguments, 1);
  return bind(parser, function(result) {
    return bind(and.apply(null, parsers), function() {
      return value(result);
    });
  });
}

/**
 * Returns a parser that returns an array of results that have been successfully
 * parsed by `parser`, which were separated by `separator`.
 *
 * @param {core.Parser} parser - Parser for matching and collecting results.
 * @param {core.Parser} separator - Parser for the separator
 * @param {Object} [opts]
 * @param {integer} [opts.min=0] - Minimum length of the resulting array.
 * @param {integer} [opts.max=0] - Maximum length of the resulting array.
 * @returns {core.Parser}
 * @memberof combinators
 */
function split(parser, separator, opts) {
  opts = opts || {};
  if (!opts.min) {
    return or(split(parser, separator, {min: 1, max: opts.max}),
              value([]));
  } else {
    opts = copy(opts);
    opts.min = opts.min && opts.min-1;
    opts.max = opts.max && opts.max-1;
    return sequence(function(s) {
      var x = s(parser);
      var xs = s(collect(and(separator, parser), opts));
      var result = [x].concat(xs);
      return value(result);
    });
  }
}

/**
 * Returns a parser that returns an array of results that have been successfully
 * parsed by `parser`, separated and ended by `separator`.
 *
 * @param {core.Parser} parser - Parser for matching and collecting results.
 * @param {core.Parser} separator - Parser for the separator
 * @param {Object} [opts]
 * @param {integer} [opts.enforceEnd=true] - If true, `separator` must be at the
 *                                           end of the parse.
 * @param {integer} [opts.min=0] - Minimum length of the resulting array.
 * @param {integer} [opts.max=0] - Maximum length of the resulting array.
 * @returns {core.Parser}
 * @memberof combinators
 */
function splitEnd(parser, separator, opts){
  opts = opts || {};
  var enforceEnd = typeof opts.enforceEnd === "undefined" ?
        true :
        opts.enforceEnd;
  return followedBy(split(parser, separator, {min: opts.min, max: opts.max}),
                    enforceEnd ? separator : maybe(separator));
}

/**
 * Returns a parser that results in an array of `min` to `max` matches of
 * `parser`
 *
 * @param {core.Parser} parser - Parser to match.
 * @param {Object} [opts]
 * @param {integer} [opts.min=0] - Minimum number of matches.
 * @param {integer} [opts.max=Infinity] - Maximum number of matches.
 * @returns {core.Parser}
 * @memberof combinators
 */
function collect(parser, opts) {
  opts = opts || {};
  var min = opts.min || 0,
      max = typeof opts.max === "undefined" ? Infinity : opts.max;
  if (min > max) { throw new Error("min must be less than or equal to max"); }
  return function(parserState) {
    var prev = parserState,
        s = parserState,
        res = [],
        i = 0;
    while(s = parser(s), i < max && !s.failed) {
      res.push(s.value);
      i++;
      prev = s;
    }
    if (min && (res.length < min)) {
      return s;
    } else {
      return value(res)(prev);
    }
  };
}

/**
 * Returns a parser that results in an array of exactly `n` results for
 * `parser`.
 *
 * @param {core.Parser} parser - The parser to collect results for.
 * @param {integer} n - exact number of results to collect.
 * @returns {core.Parser}
 * @memberof combinators
 */
function exactly(parser, n) {
  return collect(parser, {min: n, max: n});
}

/**
 * Returns a parser that results in a value between an opening and closing
 * parser.
 *
 * @param {core.Parser} open - Opening parser.
 * @param {core.Parser} close - Closing parser.
 * @returns {core.Parser}
 * @memberof combinators
 */
function between(open, close, parser) {
  return and(open, followedBy(parser, close));
}

/**
 * Returns a parser that skips input until `parser` stops matching.
 *
 * @param {core.Parser} parser - Determines whether to continue skipping.
 * @returns {core.Parser}
 * @memberof combinators
 */
function skip(parser) {
  return and(collect(parser), value());
}

/**
 * Returns a parser that accepts a parser if its result is within range of
 * `start` and `end`.
 *
 * @param {*} start - lower bound of the range to accept.
 * @param {*} end - higher bound of the range to accept.
 * @param {core.Parser} [parser=token()] - parser whose results to test
 * @param {Function} [predicate=function(x,y){return x<=y; }] - Tests range
 */
function range(start, end, parser, predicate) {
  parser = parser || token();
  predicate = predicate || function(x,y) { return x <= y; };
  return label(bind(parser, function(result) {
    if (predicate(start, result) && predicate(result, end)) {
      return value(result);
    } else {
      return fail();
    }
  }), "value between {"+start+"} and {"+end+"}");
}

/**
 * String-related parsers and combinators.
 *
 * @namespace strings
 */

/**
 * Returns a string containing the concatenated results returned by applying
 * `parser`. `parser` must be a combinator that returns an array of string parse
 * results.
 *
 * @param {core.Parser} parser - Parser that results in an array of strings.
 * @returns {core.Parser}
 * @memberof strings
 */
function stringOf(parser) {
  return bind(parser, function(xs) {
    if (xs.hasOwnProperty("length") &&
        xs.join) {
      return value(xs.join(""));
    } else {
      return fail();
    }
  });
}

/**
 * Returns a parser that succeeds if the next token is one of the provided
 * `chars`.
 *
 * @param {String|Array} chars - Character bag to match the next
 *                                          token against.
 * @param {Boolean} [caseSensitive=true] - Whether to match char case exactly.
 * @returns {core.Parser}
 * @memberof strings
 */
function oneOf(chars, caseSensitive) {
  caseSensitive = typeof caseSensitive === "undefined" ? true : caseSensitive;
  chars = caseSensitive ? chars : chars.toLowerCase();
  return label(is(function(x) {
    x = caseSensitive ? x : x.toLowerCase();
    return ~chars.indexOf(x);
  }), "one of {"+chars+"}");
}

/**
 * Returns a parser that fails if the next token matches any of the provided
 * `chars`.
 *
 * @param {String|Array} chars - Character bag to match against.
 * @param {Boolean} [caseSensitive=true] - Whether to match char case exactly.
 * @returns {core.Parser}
 * @memberof strings
 */
function noneOf(chars, caseSensitive) {
  caseSensitive = typeof caseSensitive === "undefined" ? true : caseSensitive;
  chars = caseSensitive ? chars : chars.toLowerCase();
  return label(is(function(x) {
    x = caseSensitive ? x : x.toLowerCase();
    return !~chars.indexOf(x);
  }), "none of {"+chars+"}");
}

/**
 * Returns a parser that succeeds if `str` matches the next `str.length` inputs,
 * consuming the string and returning it as a value.
 *
 * @param {String} str - String to match against.
 * @param {Boolean} [caseSensitive=true] - Whether to match char case exactly.
 * @returns {core.Parser}
 * @memberof strings
 */
function string(str, caseSensitive) {
  caseSensitive = typeof caseSensitive === "undefined" ? true : caseSensitive;
  str = caseSensitive ? str : str.toLowerCase();
  return label(sequence(function(s) {
    var x = s(is(function(x) {
      x = caseSensitive ? x : x.toLowerCase();
      return  x === str[0];
    }, str.charAt(0)));
    var xs = (str.length > 1)?s(string(str.slice(1), caseSensitive)):"";
    return value(x+xs);
  }), "string matching {"+str+"}");
}

/**
 * Returns a parser that matches a single non-unicode uppercase alphabetical
 * character.
 *
 * @returns {core.Parser}
 * @memberof strings
 */
function alphaUpper() {
  return label(range("A", "Z"), "uppercase alphabetical character");
}

/**
 * Returns a parser that matches a single non-unicode lowercase alphabetical
 * character.
 *
 * @returns {core.Parser}
 * @memberof strings
 */
function alphaLower() {
  return label(range("a", "z"), "lowercase alphabetical character");
}

/**
 * Returns a parser that matches a single non-unicode alphabetical character.
 *
 * @returns {core.Parser}
 * @memberof strings
 */
function alpha() {
  return or(alphaLower(), alphaUpper(), "alphabetical character");
}

/**
 * Returns a parser that parses a single digit character token from the input.
 *
 * @param {integer} [base=10] - Optional base for the digit.
 * @returns {core.Parser}
 * @memberof strings
 */
function digit(base) {
  base = base || 10;
  return label(is(function(x) { return !isNaN(parseInt(x, base)); }),
               "digit");
}

/**
 * Returns a parser that matches an alphanumeric character.
 *
 * @param {integer} [base=10] - Optional base for numeric parsing.
 * @returns {core.Parser}
 * @memberof strings
 */
function alphanum(base) {
  return label(or(alpha(), digit(base)), "alphanum");
}

/**
 * Returns a parser that matches one whitespace character.
 *
 * @returns {core.Parser}
 * @memberof strings
 */
function space() {
  return label(oneOf(" \t\n\r"), "space");
}

/**
 * Returns a parser that matches one or more whitespace characters. Returns a
 * single space character as its result, regardless of which whitespace
 * characters were matched.
 *
 * @returns {core.Parser}
 * @memberof strings
 */
function spaces() {
  return label(and(space(), skip(space()), value(" ")), "spaces");
}

/**
 * Returns a parser that collects between `min` and `max` tokens matching
 * `parser`. The result is returned as a single string. This parser is
 * essentially collect() for strings.
 *
 * @param {core.Parser} [parser=token()] - Parser to use to collect the results.
 * @param {Object} [opts]
 * @param {integer} [opts.min=0] - Minimum number of matches.
 * @param {integer} [opts.max=Infinity] - Maximum number of matches.
 * @returns {core.Parser}
 * @memberof strings
 */
function text(parser, opts) {
  parser = parser || token();
  opts = opts || {};
  return stringOf(collect(parser, opts));
}

/**
 * Returns a parser that trims any whitespace surrounding `parser`.
 *
 * @param {core.Parser} parser - Parser to match after cleaning up whitespace.
 * @returns {core.Parser}
 * @memberof strings
 */
function trim(parser) {
  return between(maybe(spaces()),
                 maybe(spaces()),
                 parser);
}

/**
 * Returns a parser that trims any leading whitespace before `parser`.
 *
 * @param {core.Parser} parser - Parser to match after cleaning up whitespace.
 * @returns {core.Parser}
 * @memberof strings
 */
function trimLeft(parser) {
  return and(maybe(spaces()), parser);
}

/**
 * Returns a parser that trims any trailing whitespace before `parser`.
 *
 * @param {core.Parser} parser - Parser to match after cleaning up whitespace.
 * @returns {core.Parser}
 * @memberof strings
 */
function trimRight(parser) {
  return followedBy(parser, maybe(spaces()));
}

/**
 * Number-related parsers and combinators
 *
 * @namespace numbers
 */

/**
 * Returns a parser that matches a natural number. That is, a number without a
 * positive/negative sign or decimal places, and returns a positive integer.
 *
 * @param {integer} [base=10] - Base to use when parsing the number.
 * @returns {core.Parser}
 * @memberof numbers
 */
function natural(base) {
  base = base || 10;
  return map(function(str) { return parseInt(str, base); },
             text(digit(base), {min: 1}));
}

/**
 * Returns a parser that matches an integer, with an optional + or - sign.
 *
 * @param {integer} [base=10] - Base to use when parsing the integer.
 * @returns {core.Parser}
 * @memberof numbers
 */
function integer(base) {
  base = base || 10;
  return sequence(function(s) {
    var sign = s(maybe(or(string("+"),
                          string("-")))),
        num = s(natural(base));
    return value(num * (sign === "-" ? -1 : 1));
  });
}

/**
 * Returns a parser that will parse floating point numbers.
 *
 * @returns {core.Parser}
 * @memberof numbers
 */
function float() {
  return sequence(function(s) {
    var leftSide = s(integer());
    var rightSide = s(or(and(string("."),
                             integer()),
                         value(0)));
    while (rightSide > 1) {
      rightSide = rightSide / 10;
    }
    rightSide = leftSide >= 0 ? rightSide : (rightSide*-1);
    var e = s(or(and(string("e", false),
                     integer()),
                 value(0)));
    return value((leftSide + rightSide)*(Math.pow(10, e)));
  });
}

module.exports = {
  // API
  version: VERSION,
  parse: parse,
  parseAsync: parseAsync,
  // Base parsers
  value: value,
  bind: bind,
  fail: fail,
  label: label,
  token: token,
  eof: eof,
  log: log,
  delay: delay,
  map: map,
  tag: tag,
  lookAhead: lookAhead,
  is: is,
  isNot: isNot,
  // Combinators
  and: and,
  or: or,
  maybe: maybe,
  not: not,
  unless: unless,
  sequence: sequence,
  followedBy: followedBy,
  split: split,
  splitEnd: splitEnd,
  collect: collect,
  exactly: exactly,
  between: between,
  skip: skip,
  range: range,
  // String-related parsers
  stringOf: stringOf,
  oneOf: oneOf,
  noneOf: noneOf,
  string: string,
  alphaLower: alphaLower,
  alphaUpper: alphaUpper,
  alpha: alpha,
  digit: digit,
  alphanum: alphanum,
  space: space,
  spaces: spaces,
  text: text,
  trim: trim,
  trimLeft: trimLeft,
  trimRight: trimRight,
  // Numbers
  natural: natural,
  integer: integer,
  float: float
};

/*
 * Internals
 */
function copy(obj) {
  var newObj = Object.create(Object.getPrototypeOf(obj));
  for (var key in obj) {
    if (obj.hasOwnProperty(key)) {
      newObj[key] = obj[key];
    }
  }
  return newObj;
}

function mergeErrors(err1, err2) {
  if (!err1 || (!err1.messages.length && err2.messages.length)) {
    return err2;
  } else if (!err2 || (!err2.messages.length && err1.messages.length)) {
    return err1;
  } else {
    var pos;
    switch (comparePositions(err1.position, err2.position)) {
    case "gt":
      pos = err1.position;
      break;
    case "lt":
      pos = err2.position;
      break;
    case "eq":
      pos = err1.position;
      break;
    }
    var newMessages =
          (err1.messages.concat(err2.messages)).reduce(function(acc, x) {
            return (~acc.indexOf(x)) ? acc : acc.concat([x]);
          }, []);
    return new ParserError(pos,
                           newMessages,
                           err2.type,
                           err2.wasEof || err1.wasEof);
  }
}

function comparePositions(pos1, pos2) {
  if (pos1.line < pos2.line) {
    return "lt";
  } else if (pos1.line > pos2.line) {
    return "gt";
  } else if (pos1.column < pos2.column) {
    return "lt";
  } else if (pos1.column > pos2.column) {
    return "gt";
  } else {
    return "eq";
  }
}

function ParserState(value, input, offset, userState,
                     position, hasConsumed, error, failed) {
  this.value = value;
  this.input = input;
  this.offset = offset;
  this.position = position;
  this.userState = userState;
  this.failed = failed;
  this.error = error;
}
