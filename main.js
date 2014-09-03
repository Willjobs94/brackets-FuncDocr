/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/*global define, $, brackets, window */

/** extension to generate JSDoc annotations for functions */
define(function (require, exports, module) {
    'use strict';

	var AppInit            	= brackets.getModule("utils/AppInit");
    var CodeHintManager     = brackets.getModule("editor/CodeHintManager");
    var CommandManager      = brackets.getModule('command/CommandManager');
	var Commands            = brackets.getModule("command/Commands");
    var KeyEvent            = brackets.getModule('utils/KeyEvent');
    var EditorManager       = brackets.getModule('editor/EditorManager');
    var KeyBindingManager   = brackets.getModule('command/KeyBindingManager');
    var Menus               = brackets.getModule('command/Menus');

    var COMMAND_ID          = 'funcdocr';
    var COMMAND_ID_TAB      = 'funcdocrTab';
    var FUNCTION_REGEXP     = /function(?:\s+[A-Za-z\$\_][A-Za-z\$\_0-9]*)?\s*\(([^\)]*)\)/;
    var INDENTATION_REGEXP  = /^([\t\ ]*)/;

    var DOCBLOCK_BOUNDARY   = /[A-Za-z\[\]]/;
    var DOCBLOCK_START      = /^\s*\/\*\*/;
    var DOCBLOCK_MIDDLE     = /^\s*\*/;
    var DOCBLOCK_END        = /^\s*\*\//;
    var DOCBLOCK_FIELD      = /(\[\[[^\]]+\]\])/;
    var DOCBLOCK_LAST_FIELD = /.*(\[\[[^\]]+\]\])/;
	var DOCBLOCK_PAR_OR_RET = /^\s*\* (\s{6,}|@(param|returns?))/;


	var PROPERTIES 			= ['arity', 'caller', 'constructor', 'length', 'prototype'];
	var STRING_FUNCTIONS	= ['charAt', 'charCodeAt', 'codePointAt', 'contains', 'endsWith',
							   'localeCompare', 'match', 'normalize', 'repeat', 'replace', 'search',
							   'split', 'startsWith', 'substr', 'substring', 'toLocaleLowerCase',
							   'toLocaleUpperCase', 'toLowerCase', 'toUpperCase', 'trim', 'valueOf'];
	var ARRAY_FUNCTIONS		= ['fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift', 'join'];
	var OBJECT_FUNCTIONS 	= ['create', 'defineProperty', 'defineProperties', 'freeze', 'getOwnPropertyDescriptor',
							   'getOwnPropertyNames', 'getOwnPropertySymbols', 'getPrototypeOf', 'isExtensible',
							   'isFrozen', 'isSealed', 'keys', 'preventExtensions', 'seal', 'setPrototypeOf'];
	var REGEXP_FUNCTIONS 	= ['exec','test'];

    var PARAM_WRAPPERS = {
        'javascript'   : ['{', '}'],
        'coffeescript' : ['{', '}'],
        'livescript'   : ['{', '}'],
        'php'          : ['', '']
    };

	var langId;

    // =========================================================================
    // Doc Block Generation
    // =========================================================================

    /**
     * Handle the shortcut to create a doc block
     */
    function handleDocBlock() {
        insertDocBlock(generateDocBlock(getFunctionSignature()));
    }

    /**
     * Get the signature of the currently selected function
     * @returns {Object} [.description],[.parameter],[.returns]
     */
    function getFunctionSignature() {
        var editor      = EditorManager.getCurrentFullEditor();
		langId  		= editor.getLanguageForSelection().getId();
        var position    = editor.getCursorPos();
        var document    = editor.document;
        var lineBefore  = document.getLine(position.line-1);
        var currentLine = document.getLine(position.line);
        var matches     = FUNCTION_REGEXP.exec(currentLine);
        var docExists   = DOCBLOCK_END.test(lineBefore) ? true : false;

        var signature   = {};

        if (!matches) {
            return null;
        }

        signature.indentation = INDENTATION_REGEXP.exec(currentLine)[0];
        signature.parameters  = [];

        var parameters = matches[1].split(',');

        for (var i = 0; i < parameters.length; ++i) {
            var name = parameters[i].trim();

            if (name) {
                signature.parameters.push({title:name});
            }
        }

		// default
		signature.returns = {bool: false};

		// get the function code and returns (Object)
		var codeTypes = getFunctionCodeTypes(editor,position,signature.parameters);
		if (codeTypes) {
			signature.returns = codeTypes.returns;
			for (var i = 0; i < codeTypes.paramTypes.length; i++) { // add the paramTypes to signature.parameters
				signature.parameters[i].type = codeTypes.paramTypes[i];
			}
		}


		if (docExists) { // try to update the doc block (parameter added or deleted)
			var doc = getExistingDocSignature(document,position);
			var docStartLine = doc.startLine;
			var docSignature = doc.signature;

			// merge the docSignature into signature
			if (docSignature.description != '') {
				signature.description = docSignature.description;
			}
			var parameterTitles = [];
			signature.parameters.forEach(function(o){parameterTitles.push(o.title);} );

			for (var i = 0; i < docSignature.parameters.length; i++) {
				var paramIndex;
				if ((paramIndex = parameterTitles.indexOf(docSignature.parameters[i].title)) >= 0) {
					signature.parameters[paramIndex] = docSignature.parameters[i];
				}
			}
			if (signature.returns.bool) {
				if (docSignature.returns) {
					if (docSignature.returns.type == '[[Type]]') {
						signature.returns.description = docSignature.returns.description;
					} else {
						signature.returns = docSignature.returns;
					}
				}
				signature.returns.bool = true;
			}
			editor._codeMirror.replaceRange('', {ch: 0, line: docStartLine}, {ch: 0, line: position.line});
		}
        return signature;
    }

	/**
	 * Get the existing doc tags
	 * @param   {document} document brackets document
	 * @param   {Object}   position current cursor position
	 * @returns {Object}   get startLine of the doc and the tags (.signature)
	 */
	function getExistingDocSignature(document,position) {
		// get start line of documentation
		var i = 1;
		var currentLine = document.getLine(position.line-i);
		var docLines = [];
		while (!DOCBLOCK_START.test(currentLine)) {
			docLines.push(currentLine);
			i++;
			currentLine = document.getLine(position.line-i);
		}
		docLines.reverse();
		return {startLine: position.line-i, signature: getCurrentDocTags(docLines)};
	}

	/**
	 * Get all tags that are set in the existing doc block
	 * @param   {Array}  lines doc block lines
	 * @returns {Object} tags .descriptions,.params,.returns
	 */
	function getCurrentDocTags(lines) {
		var tags = {};

		// trim lines
		for (var i = 0; i < lines.length; i++) {
			lines[i] = lines[i].trim(); // trim each line
			if (lines[i].substr(0,2) == "*/") { lines = lines.slice(0,i); break; }
			lines[i] = lines[i].replace(/^\*/,'').trim(); // delete * at the beginning and trim line again
		}

		var commentTags = lines.join('\n').split('@');

		tags.description = commentTags[0].replace(/\n*$/,''); // the first (without @ is the description/summary)

		var params = [];
		for (var i = 1; i < commentTags.length; i++) {
			// get params
			if (commentTags[i].substr(0,5) === 'param') {
				var param_parts = commentTags[i].split(/(\s)+/);

				var param = {};
				// get the split delimiters
				var delimiters = param_parts.filter(function(v,i) { return ((i % 2) === 1); });
				param_parts = param_parts.filter(function(v,i) { return ((i % 2 === 0)); });


				// 0 = param, [1 = type], 2 = title 3- = description
				switch(langId) {
					case "javascript":
					case "coffeescript":
					case "livescript":
						if (param_parts[1].charAt(0) != '{') {
							param_parts.splice(1,0,false);  // add the type false
							delimiters.splice(1,0,'');  // no delimuter
							param.type = false;
						} else {
							// get the correct ending }
							for (var p = 1; p < param_parts.length; p++) {
								if (param_parts[p].slice(-1) == '}') {
									break;
								}
							}
							var type = param_parts[1];
							for (var t = 2; t <= p; t++) {
								type += delimiters[t-1] + param_parts[t];
							}
							param.type = type.substring(1,type.length-1); // remove { }
							// delete mulitline parts from type so param_parts[2] is the title
							param_parts.splice(2,p-1);
							delimiters.splice(2,p-1); // and remove the delimiters
						}
					break;
					case "php":
						if (param_parts[1].charAt(0) == '$') {
							param_parts.splice(1,0,false);  // add the type false
							param.type = false;
						} else {
							if (param_parts[1].charAt(0) == '{') {
								param.type = param_parts[1].substring(1,param_parts[1].length-1);
							} else {
								param.type = param_parts[1];
							}
						}
					break;
				}
				param.title			= param_parts[2];
				param.description   = param_parts[3];
				for (var j = 4; j < param_parts.length; j++) {
					param.description += delimiters[j-1] + param_parts[j];
				}
				param.description = param.description.replace(/\n*$/,'');
				params.push(param);
			}


			if (commentTags[i].substr(0,6) === 'return') {
				if (commentTags[i].substr(0,7) === 'returns') {
					var  return_tag = commentTags[i].substr(7).trim(); // delete returns and trim
				} else {
					var  return_tag = commentTags[i].substr(6).trim(); // delete return and trim
				}
				if(return_tag.charAt(0) == '{') {
					// get the correct end Curly
					var bracketCount = 1;
					for (var t = 1; t < return_tag.length; t++) {
						if (return_tag.charAt(t) == '{') bracketCount++;
						else if (return_tag.charAt(t) == '}') bracketCount--;
						if (bracketCount === 0) break;
					}
					var endCurly = t;
					tags.returns = {description: return_tag.substr(endCurly+1).trim(),type:return_tag.substring(1,endCurly).replace(/[ \n]*$/,'')};
				}else {
					var firstSpace = return_tag.indexOf(' ');
					tags.returns = {type: (firstSpace >= 0) ? return_tag.substr(0,firstSpace) : return_tag.substr(0),
									description: return_tag.substr(firstSpace+1).trim()};
				}
				break; // no @ after return[s]
			}
		}
		tags.parameters = params;
		return tags;
	}

    /**
     * Generate the doc block for a function signature
     * @param   {Object} signature .description,.parameter,.returns
     * @returns {String} the doc block with the correct indentation
     */
    function generateDocBlock(signature) {
        if (!signature) {
            return null;
        }

        var editor  = EditorManager.getCurrentFullEditor();
        var wrapper = PARAM_WRAPPERS[langId];

        if (!wrapper) {
            console.warn('Unsupported language: ' . langId);
            return null;
        }

        var output = ['/**'];

		// add description
		signature.description = "description" in signature ? signature.description.split(/\n/) : ['[[Description]]'];
		for (var d = 0; d < signature.description.length; d++) {
			output.push(' * '+signature.description[d]);
		}


        // Determine the longest parameter and the longest type so we can right-pad them
        var maxParamLength = 0;
        var maxTypeLength = 0;
        for (var i = 0; i < signature.parameters.length; i++) {
            var parameter 	= signature.parameters[i]; // parameter changes => signature changes
			parameter.type 	= parameter.type ? parameter.type.trim().split(/\n/) : ['[[Type]]'];

            if (parameter.title.length > maxParamLength) {
                maxParamLength = parameter.title.length;
            }

			// check every line
			for (var p = 0; p < parameter.type.length; p++) {
				if (parameter.type[p].length > maxTypeLength) {
					maxTypeLength = parameter.type[p].length;
				}
			}
        }

		if (signature.returns.bool) {
			signature.returns.type 	= signature.returns.type ? signature.returns.type.trim().split(/\n/) : ['[[Type]]'];
			// check every line
			for (var p = 0; p < signature.returns.type.length; p++) {
				if (signature.returns.type[p].length > maxTypeLength) {
					maxTypeLength = signature.returns.type[p].length;
				}
			}
		}




		// if returns is set show align the types of params and returns
		var tagRightSpace = signature.returns.bool ? '   ' : ' ';

        // Add the parameter lines
        for (var i = 0; i < signature.parameters.length; i++) {
            var parameter = signature.parameters[i];
			parameter.description 	= parameter.description	? parameter.description.split(/\n/) : ['[[Description]]'];

			// get the right spaces for title and type
			parameter.titleRightSpace	= new Array(maxParamLength + 2 - parameter.title.length).join(' ');

			 // singleline
			if (parameter.type.length == 1) {
				parameter.typeRightSpace 	= new Array(maxTypeLength + 2 - parameter.type[0].length).join(' ');
				output.push(' * @param'+ tagRightSpace + wrapper[0] + parameter.type[0] + wrapper[1] +
							parameter.typeRightSpace + parameter.title + parameter.titleRightSpace +parameter.description[0]);
			} else { // multiline
				output.push(' * @param' + tagRightSpace + wrapper[0]);
				parameter.typeIndent = new Array(output[output.length-1].length-3).join(' ');
				for (var t = 0; t < parameter.type.length; t++) {
					output.push(' *   ' + parameter.typeIndent + parameter.type[t]);
				}
				parameter.typeRightSpace 	= new Array(maxTypeLength+2).join(' ');
				output.push(' * ' + parameter.typeIndent + wrapper[1] +
							parameter.typeRightSpace + parameter.title + parameter.titleRightSpace +parameter.description[0]);
			}
			parameter.descriptionIndent = new Array(output[output.length-1].length-2-parameter.description[0].length).join(' ');
			for (var d = 1; d < parameter.description.length; d++) {
				output.push(' * ' + parameter.descriptionIndent + parameter.description[d]);
			}
        }

        // Add the return line
        if (signature.returns.bool) {
			signature.returns.description 			= signature.returns.description ? signature.returns.description.split(/\n/) : ['[[Description]]'];
			// singleline
			if (signature.returns.type.length == 1) {
				signature.returns.typeRightSpace = new Array(maxTypeLength + 2 - signature.returns.type[0].length).join(' ');
				output.push(' * @returns ' + wrapper[0] + signature.returns.type[0] + wrapper[1] +
							signature.returns.typeRightSpace + signature.returns.description[0]);
				signature.returns.descriptionIndent = new Array(output[output.length-1].length-2-signature.returns.description[0].length).join(' ');
			} else { // multiline
				output.push(' * @returns ' + wrapper[0]);
				signature.returns.typeIndent = new Array(output[output.length-1].length-3).join(' ');
				for (var t = 0; t < signature.returns.type.length; t++) {
					output.push(' *   ' + signature.returns.typeIndent + signature.returns.type[t]);
				}
				output.push(' * ' + signature.returns.typeIndent + wrapper[1]);
				signature.returns.descriptionIndent = '';
				output.push(' * ' + signature.returns.descriptionIndent + signature.returns.description[0]);
			}

			for (var d = 1; d < signature.returns.description.length; d++) {
				output.push(' * ' + signature.returns.descriptionIndent + signature.returns.description[d]);
			}
        }

        output.push(' */');
        return signature.indentation + output.join('\n' + signature.indentation) + '\n';
    }



    /**
     * Insert the docBlock
     * @param {String} docBlock the generated doc block
     */
    function insertDocBlock(docBlock) {
        if (!docBlock) {
            return;
        }

        var editor   = EditorManager.getCurrentFullEditor();
        var position = editor.getCursorPos();
        position.ch  = 0;

        editor._codeMirror.replaceRange(docBlock, position);

        // Start at the first line, just before [[Description]]
        var lines         = docBlock.split('\n');
		var endPosition   = editor.getCursorPos();
		var startPosition = Object.create(endPosition);
		startPosition.line -= lines.length - 2;
        startPosition.ch    = lines[0].length;

		// jump to te first [[Tag]]
		var docBlockPos = {
			start: 	startPosition.line-1,
			end:	endPosition.line-1
		};
		var nextField = getNextField({start:startPosition,end:startPosition},false,docBlockPos);

        if (nextField) {
            editor.setSelection(nextField[1], nextField[0]); // set the selection
			CommandManager.execute(Commands.SHOW_CODE_HINTS);
		}

        EditorManager.focusEditor();
    }


	// =========================================================================
    // Key Handling (Enter,Tab)
    // =========================================================================


	/**
	 * Handle the key Event jump to handleEnter or handleTab (inside a doc block) or do nothing
	 * @param {keyEvent} $event jQuery key event
	 *
	 * @param {editor}   editor Brackets editor
	 * @param {Object}   event  key event
	 */
	function handleKey($event,editor,event) {
		langId  	  = editor.getLanguageForSelection().getId();
		var selection = editor.getSelection();
		var backward  = event.shiftKey;
		if (event.type === 'keydown' && event.keyCode === KeyEvent.DOM_VK_TAB ||
			event.type === 'keyup'  && event.keyCode === KeyEvent.DOM_VK_RETURN) {
			var docBlockPos = insideDocBlock(selection,backward);
			if (docBlockPos && event.keyCode === KeyEvent.DOM_VK_TAB) {
				handleTab(editor,event,docBlockPos);
			} else if (event.keyCode === KeyEvent.DOM_VK_RETURN) {	// no docBlock needed (check it later)
				handleEnter(editor);
			}
		}
	}

	/**
	 * Get the current position based on the selection and backward or not
	 * @param   {Object}  selection current selection
	 * @param   {Boolean} backward  true => back
	 * @returns {Object}  position (.ch,.line)
	 */
	function getPosition(selection,backward) {
        var position;
		if (selection.start.line !== selection.end.line) {
            position = selection.start.line > selection.end.line ? selection.start : selection.end;
        }
        else {
            position = selection.start.ch > selection.end.ch ? selection.start : selection.end;
        }

        // Reverse the position if we're moving backward
        if (backward) {
            position = position === selection.start ? selection.end : selection.start;
        }
		return position;
	}

	/**
	 * Check if the current selection is inside a doc block
	 * @param   {Object}         selection current selection
	 * @param   {Boolean}        backward  true => back
	 * @returns {Boolean|Object} Object(.start,.end) => inside, false => outside [[Tag]]
	 */
	function insideDocBlock(selection,backward) {
		var editor    = EditorManager.getCurrentFullEditor();
        var document  = editor.document;
        var lineCount = editor.lineCount();

        // Determine the cursor position based on the selection
        var position = getPosition(selection,backward);

        // Snap to the word boundary
        var currentLine = document.getLine(position.line);

        while (currentLine.charAt(position.ch).match(DOCBLOCK_BOUNDARY)) {
            position.ch -= 1;

            if(position.ch < 0) {
                position.ch = 0;
                break;
            }
            else if(position.ch >= currentLine.length) {
                position.ch = currentLine.length - 1;
                break;
            }
        }

        // Search for the start of the doc block
        var start = null;

        for (var i = position.line; i >= 0; --i) {
            var line = document.getLine(i);

            // Check for the start of the doc block
            if (line.match(DOCBLOCK_START)) {
                start = i;
                break;
            }

            // Make sure we're still in a doc block
            if (!line.match(DOCBLOCK_MIDDLE) && !line.match(DOCBLOCK_END)) {
                break;
            }
        }

        // If no start was found, we're not in a doc block
        if (start === null) {
            return false;
        }

        // Search for the end of the doc block
        var end = null;

        for (var i = position.line; i < lineCount; ++i) {
            var line = document.getLine(i);

            // Check for the end of the doc block
            if (line.match(DOCBLOCK_END)) {
                end = i;
                break;
            }

            // Make sure we're still in a doc block
            if (!line.match(DOCBLOCK_START) && !line.match(DOCBLOCK_MIDDLE)) {
                break;
            }
        }

        // If no end was found, we're not in a doc block
        if (end === null) {
            return false;
        }

		// we are in a doc block
		return {start: start, end: end};
	}


	// =========================================================================
    // Enter Handling
    // =========================================================================

	/**
     * Handle the enter key when within a doc block
     * @param {editor} editor Brackets editor
     */
    function handleEnter(editor) {
		var editor  	= EditorManager.getCurrentFullEditor();
		var document 	= editor.document;
		var position	= editor.getCursorPos();
		var lastLine 	= document.getLine(position.line-1); // before enter
		var currentLine = document.getLine(position.line); // after enter
		enterAfter(editor,lastLine,currentLine,position);
    }

	/**
	 * Insert * in the line after line and padding
	 * @param {Object} editor      brackets editor
	 * @param {String} lastLine    line before enter
	 * @param {String} currentLine line after enter
	 * @param {Object} position    current position
	 */
	function enterAfter(editor,lastLine,currentLine,position) {
		if (DOCBLOCK_PAR_OR_RET.test(lastLine)) {
			// get the correct wrapper ({} for JS or '' for PHP)
			var wrapper 		= PARAM_WRAPPERS[langId];
			var paddingRegex 	= new RegExp('^(\\s+)\\* @(param|returns?)\\s+'+wrapper[0]+'.+'+wrapper[1]+'\\s+[^ ]+\\s+');
			var match 			= paddingRegex.exec(lastLine);
			// for the second enter there is no * @param or @returns
			if (!match) {
				paddingRegex 	= new RegExp('^(\\s+)\\*\\s+');
				match 			= paddingRegex.exec(lastLine);
			}
			if (match) {
				// match[1] => spaces/tabs before *
				var padding = match[1]+'\*'+new Array(match[0].length-match[1].length).join(' ');
				editor.document.replaceRange(
					padding,
				 	{line:position.line,ch:0},
				 	{line:position.line,ch:currentLine.length}
				);
			}
		}
	}

    // =========================================================================
    // Tab Handling
    // =========================================================================

    /**
     * Handle the tab key when within a doc block
     * @param {editor} editor      Brackets editor
     * @param {Object} event       keyEvent
     * @param {Object} docBlockPos (.start,.end) docBlock line start and end
     */
    function handleTab(editor,event,docBlockPos) {
		var selection = editor.getSelection();
		var backward  = event.shiftKey;
		var nextField = getNextField(selection, backward, docBlockPos);

		if (nextField) {
			editor.setSelection(nextField[1], nextField[0]); // set the selection
			CommandManager.execute(Commands.SHOW_CODE_HINTS);
			event.preventDefault();
		}
    }


    /**
     * Gets the next tabbable field within the doc block based on the cursor's position
     * @param   {Object}  selection   selected Text psoition {start<.ch,.line>,end<.ch,.line>
     * @param   {Boolean} backward    Set to true to search backward
     * @param   {Object}  docBlockPos start and end position of the docBlock
     * @param   {Boolean} stop        Set to true stop looping back around to search again
     * @returns {array}   start position,end position (.ch,.line)
     */
    function getNextField(selection, backward, docBlockPos, stop) {
		var editor    	= EditorManager.getCurrentFullEditor();
        var document 	= editor.document;
        var lineCount 	= editor.lineCount();

		var position	= getPosition(selection,backward);
		var start 		= docBlockPos.start;
		var end 		= docBlockPos.end;

        // Search for the next field
        var limit     = backward ? position.line - start : end - position.line;
        var direction = backward ? -1 : 1;
        var field     = null;

        for (var i = 0; i < limit; ++i) {
            var lineNumber   = position.line + (i * direction);
            var line         = document.getLine(lineNumber);
            var start_offset = 0;
            var end_offset   = line.length;

            // If we're testing the cursor's line, we need to ignore text in front/behind based on the direction
            if (lineNumber === position.line) {
                start_offset = backward ? 0 : position.ch;
                end_offset   = backward ? position.ch : undefined;
            }

            // Find the field using regexp
            var testLine = line.substr(start_offset, end_offset);
            var pattern  = backward ? DOCBLOCK_LAST_FIELD : DOCBLOCK_FIELD;
            var match    = pattern.exec(testLine);

            if (match) {
                var index = backward ? testLine.lastIndexOf(match[1]) : testLine.indexOf(match[1]);

                var startPosition = {
                    line : lineNumber,
                    ch   : index + start_offset
                };

                var endPosition = {
                    line : lineNumber,
                    ch   : index + match[1].length + start_offset
				};

                field = backward ? [endPosition, startPosition] : [startPosition, endPosition];
                break;
            }
        }

        // If no field was found, loop back around
        if (field === null && !stop) {
            var loopPosition = {
                line : backward ? end : start,
                ch   : 0
            }

            var loopSelection = {
                start : loopPosition,
                end   : loopPosition
            };

            return getNextField(loopSelection, backward, docBlockPos, true);
        }

        return field;
    }

	// =========================================================================
    // Analyze Function Code
    // =========================================================================

	/**
	 * Get the code of a function at positon and check if the function returns a value
	 * Try to guess the parameter types
	 * @param   {Object}         editor   Brackets editor
	 * @param   {Object}         position current position (.ch,.line)
	 * @param   {Object}         params   function parameters
	 * @returns {Object|Boolean} .code = code of function, .returns (Boolean) true if function returns, .paramTypes (Array) Type of parameter
	 */
	function getFunctionCodeTypes(editor,position,params) {
		var code = editor.document.getRange({ch:0,line:position.line},{ch:0,line:editor.lineCount()});
		var length = code.length;
		var delimiter = false;
		var bracketCount = 0;
		var returns = {bool:false,type:false};
		var paramsFirstChars = [];
		var line = 0;

		for (var i = 0; i < params.length; i++) {
			paramsFirstChars.push(params[i].title.charAt(0));
		}

		var paramIndex;
		var paramTypes = [];

		for (var i = 0; i < length; i++) {
			var char = code.charAt(i);

			// get code types
			if (langId != "php" && ((paramIndex = paramsFirstChars.indexOf(char)) >= 0)) {
				if (delimiter == '') {
					while (paramIndex >= 0) { // parameters can start with the same char
						// check for currentParameter.
						if (code.substr(i,params[paramIndex].title.length+1) == params[paramIndex].title+'.') {
							var functionAfterParam = /^([a-z]*)(\()?/i.exec(code.substr(i+params[paramIndex].title.length+1));
							// check for properties
							if (!functionAfterParam[2]) {
								if (PROPERTIES.indexOf(functionAfterParam[1]) === -1) {
									paramTypes[paramIndex] = 'Object';
								}
							} else { // check for functions
								if (STRING_FUNCTIONS.indexOf(functionAfterParam[1]) !== -1) {
									paramTypes[paramIndex] = 'String';
								} else if (ARRAY_FUNCTIONS.indexOf(functionAfterParam[1]) !== -1) {
									paramTypes[paramIndex] = 'Array';
								} else if (OBJECT_FUNCTIONS.indexOf(functionAfterParam[1]) !== -1) {
									paramTypes[paramIndex] = 'Object';
								} else if (REGEXP_FUNCTIONS.indexOf(functionAfterParam[1]) !== -1) {
									paramTypes[paramIndex] = 'RegExp';
								}
							}
						}
						paramIndex = paramsFirstChars.indexOf(char,paramIndex+1); // next parameter with the correct first char
					}
				}
			}


			switch (char) {
				case 'r':
					if (delimiter == "" && /\sreturn[\[{ ]/.test(code.substr(i-1,8))) {
						returns.bool = true;
						// try to get the return type
						var matches = /\s*?([\s\S]*?);/.exec(code.substr(i+7));
						var returnText = matches[1].trim();
						var addType;
						if (returnText == "false" || returnText == "true") {
							addType = "Boolean";
							if (returns.type) {
								if (returns.type.indexOf(addType) == -1) returns.type += '|'+addType;
							} else returns.type = addType;
						} else if (returnText.charAt(0) == '{') {
							addType = "Object";
							if (returns.type) {
								if (returns.type.indexOf(addType) == -1) returns.type += '|'+addType;
							} else returns.type = addType;
						} else if (returnText.charAt(0) == "[") {
							addType = "Array";
							if (returns.type) {
								if (returns.type.indexOf(addType) == -1) returns.type += '|'+addType;
							} else returns.type = addType;
						} else if (returnText.charAt(0) == "'" || returnText.charAt(0) == '"') {
							addType = "String";
							if (returns.type) {
								if (returns.type.indexOf(addType) == -1) returns.type += '|'+addType;
							} else returns.type = addType;
						}
					}
					break;

				case '"':
				case "'":
					if (delimiter) {
						if (char === delimiter) // closing ' or "
							delimiter = false;
					}
					else delimiter = char; // starting ' or "
					break;
				case '/':
					if (!delimiter) {
						var lookahead = code.charAt(++i);
						switch (lookahead) {
							case '/': // comment
								var endComment = code.regexIndexOf(/\n/,i);
								i = endComment > i ? endComment+2 : i;
								break;
							case '*': // start of comment (/*)
								var endComment = code.regexIndexOf(/\*\//,i);
								i = endComment > i ? endComment+2 : i;
								break;
							default:
								// check for regular expression
								if (/[|&-+*%!=(;?,<>~]\s*$/.test(code.substring(0,i-1))) { // i-1 because ++i for lookahead
									var endRegex = /[^\\](?:[\\]{2})*\//;
									var endRegexMatch = endRegex.exec(code.substring(i,code.indexOf('\n',i)));
									i += endRegexMatch ? endRegexMatch.index+endRegexMatch[0].length : 0;
								}
						}
					}
					break;
				case '\\':
					switch (delimiter) {
					case '"':
					case "'":
					case "\\":
						i++;
					}
					break;
				case '{':
					if (!delimiter) {
						bracketCount++;
					}
					break;
				case '}':
					if (!delimiter) {
						bracketCount--;
						if (bracketCount === 0) {
							return {
								code:code.substr(0,i+1),
								returns: returns,
								paramTypes: paramTypes
							}
						}
					}
			} // switch
    	} // for
		return false;
	}


	String.prototype.regexIndexOf = function(regex, startpos) {
		var indexOf = this.substring(startpos || 0).search(regex);
		return (indexOf >= 0) ? (indexOf + (startpos || 0)) : indexOf;
	}

	// =========================================================================
    // Initialization
    // =========================================================================

    /**
     * Add/Remove listeners when the editor changes
     * @param {object} event     Event object
     * @param {editor} newEditor Brackets editor
     * @param {editor} oldEditor Brackets editor
     */
    function updateEditorListeners(event, newEditor, oldEditor) {
        $(oldEditor).off('keyEvent', handleKey);
        $(newEditor).on('keyEvent', handleKey);
    }


	AppInit.appReady(function () {
		require('hints');

		CommandManager.register('funcdocr', COMMAND_ID, handleDocBlock);
		KeyBindingManager.addBinding(COMMAND_ID, 'Ctrl-Alt-D');
		KeyBindingManager.addBinding(COMMAND_ID, 'Ctrl-Shift-D', 'mac');

		$(EditorManager).on('activeEditorChange', updateEditorListeners);
		$(EditorManager.getCurrentFullEditor()).on('keyEvent', handleKey);

		var docrHints = new DocrHint();
		CodeHintManager.registerHintProvider(docrHints, ["javascript", "coffeescript", "livescript" ,"php"], 0);
	});
});
