// -----------------------------------------------------------------------------
// Spell Right extension for Visual Studio Code (VSCode)
// Copyright (c) 2017-2019 Bartosz Antosik. MIT License.
// -----------------------------------------------------------------------------

'use strict';

const vscode = require('vscode');

const path = require('path');
const glob = require('glob');
const fs = require('fs');
const XRegExp = require('xregexp');
const ignore = require('ignore');
const os = require('os');
const osLocale = require('os-locale');

const langcode = require('../lib/langcode')
const doctype = require('../lib/doctype');
const parser = require('../lib/parser');

const { Deasciifier } = require("../lib/deasciifier");
const { PATTERN_LIST } = require("../lib/deasciifier/compiled_templates.js");
const asyncSeries = require('../lib/asyncSeries');

Deasciifier.init(PATTERN_LIST);

var bindings = {
    isMisspelled: (word) => { 
        if(!word) {
            return false;
        }
        return word !== Deasciifier.deasciify(word).text 
    },
    getCorrectionsForMisspelling: word => { 
       return [Deasciifier.deasciify(word).text] 
    }
}

var settings = {};

var helpers = {
    _currentPath: '',
    _DocumentSymbols: [],
    _ignoreFilesSettings: {},
    _ignoreFilesSpellignore: {},
    _commands: {
        signature: '',
        syntax: 0,
        ignore: false, // spellcheck-off or .spellignore
        force: false, // spellcheck-on
        languages: [],
        nlanguages: []
    }
};

var indicator = null;
var controller = null;
// var turkishCaseChannel;

var SpellRight = (function () {

    function SpellRight() {
        this.diagnosticMap = {};
        this.ignoreRegExpsMap = [];
        this.latexSpellParametersMap = [];
        this.lastChanges = null;
        this.lastSyntax = 0;
        this.spellingContext = [];
        this.updateInterval = 1000;
        // turkishCaseChannel = vscode.window.createOutputChannel("Orange");
    }

    SpellRight.prototype.dispose = function () {
        this.suggestCommand.dispose();
        this.lastChanges.dispose();
    };

    SpellRight.prototype.activate = function (context) {

        var subscriptions = context.subscriptions;
        this.context = context;
        this.extensionRoot = context.extensionPath;

        this.getSettings();

        var _this = this;

        indicator = new SpellRightIndicator();
        controller = new SpellRightIndicatorController(indicator);

        // add to a list of disposables
        context.subscriptions.push(controller);
        context.subscriptions.push(indicator);

        subscriptions.push(this);

        vscode.commands.registerCommand('spellright.configurationUpdate', this.configurationUpdate, this);
        vscode.commands.registerCommand('spellright.setCurrentTypeOFF', this.setCurrentTypeOFF, this);
        vscode.commands.registerCommand('spellright.setCurrentTypeON', this.setCurrentTypeON, this);
        vscode.commands.registerCommand("spellright.fixAll", this.fixAll, this);

        this.suggestCommand = vscode.commands.registerCommand(
            SpellRight.suggestCommandId, this.fixSuggestionCodeAction, this);

        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('spellright');

        vscode.workspace.onDidChangeConfiguration(this.doRefreshConfiguration, this, subscriptions);

        vscode.workspace.onDidOpenTextDocument(function (document) {
            this.doInitiateSpellCheck(document);
        }, this, subscriptions);

        vscode.workspace.onDidCloseTextDocument(function (document) {
            _this.diagnosticCollection.delete(document.uri);
            _this.diagnosticMap[document.uri.toString()] = undefined;
        }, this, subscriptions);

        vscode.workspace.onDidSaveTextDocument(function (document) {
            if(settings.recheckOnSave) {
                _this.doInitiateSpellCheck(document, true);
            }
        }, this, subscriptions);

        vscode.workspace.onDidChangeTextDocument(this.doDiffSpellCheck, this, subscriptions);

        // vscode.window.onDidChangeVisibleTextEditors(function () {
        //     _this.doInitiateSpellCheckVisible();
        // }, this, subscriptions);

        vscode.window.onDidChangeActiveTextEditor(function () {
            _this.doInitiateSpellCheckVisible();
        }, this, subscriptions);

        // register code actions provider for all languages
        vscode.languages.registerCodeActionsProvider({ scheme: '*', language: '*' }, this);

        this.doInitiateSpellCheckVisible();
    };

    SpellRight.prototype.deactivate = function () {
    }

    // wtf is this
    SpellRight.prototype.setCurrentTypeON = function () {
        var _document = vscode.window.activeTextEditor.document;
        var _documenttype = _document.languageId;

        var _i = settings.documentTypes.indexOf(_documenttype);
        if (_i == (-1)) {
            settings.documentTypes.push(_documenttype);
        }
        // Intentionally do not update configuration here because
        // setCurrentTypeON is only used when language is set
        // so configuration is updated later and only once.
    }

    SpellRight.prototype.setCurrentTypeOFF = function () {
        var _document = vscode.window.activeTextEditor.document;
        var _documenttype = _document.languageId;

        var _i = settings.documentTypes.indexOf(_documenttype);
        if (_i != (-1)) {
            settings.documentTypes.splice(_i, 1);
            this.diagnosticCollection.delete(_document.uri);
        }
        this.configurationUpdate(settings.configurationUpdate);
        indicator.updateStatusBarIndicator();

        if (SPELLRIGHT_DEBUG_OUTPUT) {
            console.log('[spellright] Turned OFF for \"' + _documenttype + '\"" document type.');
        }
    }

    
    SpellRight.prototype.selectDefaultLanguage = function () {

        // After default settings & reading settings the language is not set.
        // If it is OFF ('') then lets try to initialize it from system locales
        if (settings.language.length === 0) {
            var _locale = osLocale.sync();
            var _locale_c = '';
            if (settings.groupDictionaries) {
                _locale_c = langcode.code2Language(_locale);
            } else {
                _locale_c = langcode.code2LanguageCulture(_locale);
            }

            var _this = this;

            dictionaries.forEach(function (entry) {
                if (entry.label == _locale_c) {
                    settings.language = [entry.id];
                    return;
                }
            });
            if (SPELLRIGHT_DEBUG_OUTPUT) {
                console.log('[spellright] System locale: \"' + _locale + '\", set locale: \"' + settings.language.join(', ') + '\".');
            }
        }
    }
    
    SpellRight.prototype.configurationUpdate = function (persistent = true) {
        var _language = settings.language;
        var _documentTypes = settings.documentTypes;
        var _parserByClass = settings.parserByClass;

        if (SPELLRIGHT_DEBUG_OUTPUT) {
            console.log('[spellright] Update configuration: \"' + _language.join(', ') + '\", \"' + _documentTypes + '\".');
        }

        var _editor = vscode.window.activeTextEditor;
        var _uri = _editor.document.uri;

        if (persistent) {
            var _settings = vscode.workspace.getConfiguration('spellright', _uri);
            var _scope = this.getSettingsScope(_uri);

            _settings.update("language", _language, _scope);
            _settings.update("documentTypes", _documentTypes, _scope);
            if (Object.keys(_parserByClass).length !== 0)
                _settings.update("parserByClass", _parserByClass, _scope);
        } else {
            this.doRefreshConfiguration();
        }
    }

    SpellRight.prototype.splitCamelCase = function (word) {

        // CamelCase cases: HTMLScript, camelCase, CamelCase, innerHTML,
        // start0Case, snake_case, Snake_Case, HOMEToRent.
        var rcamel = XRegExp('(^[\\p{Ll}.@\']+)|[0-9]+|[\\p{Lu}.@\'][\\p{Ll}.@\']+|[\\p{Lu}.@\']+(?=[\\p{Lu}.@\'][\\p{Ll}.@\']|[0-9])|[\\p{Lu}.@\']+');

        var parts = [];
        XRegExp.forEach(word, rcamel, (match, i) => {
            parts.push({
                word: match[0],
                offset: match.index
            });
        });

        return parts;
    }

    SpellRight.prototype.splitSnakeCase = function (word) {

        // SnakeCase cases: HTML_Script, snake_Case, __test__.
        var rsnake = XRegExp('([^_]+)');
        var rsep = /_/;
        var parts = [];

        // We need a phantom split (e.g. for "_sth: case).
        if (rsep.test(word)) {
            parts.push({
                word: '',
                offset: 0
            });
        }

        XRegExp.forEach(word, rsnake, (match, i) => {
            parts.push({
                word: match[0],
                offset: match.index
            });
        });

        return parts;
    }

    SpellRight.prototype.splitByOtherWhite = function (word) {

        // Here split some special cases like: period (`terminal.integrated`),
        // digit (`good2know`), dash (`wp-admin`) etc. Other consequence should
        // be that these words are spelled both as split and as the whole.
        var rother = XRegExp('([^\ \.0-9\-\(\)‘’]+)');
        var rsep = /[\ \.0-9\-\(\)‘’]/;
        var parts = [];

        // We need a phantom split (e.g. for "2sth", "(sth)" case).
        if (rsep.test(word)) {
            parts.push({
                word: '',
                offset: 0
            });
        }

        XRegExp.forEach(word, rother, (match, i) => {
            parts.push({
                word: match[0],
                offset: match.index
            });
        });

        return parts;
    }

    SpellRight.prototype.prepareIgnoreRegExps = function (languageid) {

        this.ignoreRegExpsMap = [];
        this.latexSpellParametersMap = [];

        for (var i = 0; i < settings.ignoreRegExps.length; i++) {
            try {
                // Convert the JSON of RegExp Strings into a real RegExp
                var flags = settings.ignoreRegExps[i].replace(/.*\/([gimy]*)$/, '$1');
                var pattern = settings.ignoreRegExps[i].replace(new RegExp('^/(.*?)/' + flags + '$'), '$1');
                if (SPELLRIGHT_DEBUG_OUTPUT) {
                    console.log('[spellright] RegExp prepare: ' + settings.ignoreRegExps[i] + ' = /' + pattern + '/' + flags);
                }
                this.ignoreRegExpsMap.push(new RegExp(pattern, flags));
            }
            catch (e) {
                vscode.window.showErrorMessage('SpellRight: Ignore RexExp: \"' + settings.ignoreRegExps[i] + '\" malformed. Ignoring.');
                if (SPELLRIGHT_DEBUG_OUTPUT) {
                    console.log('[spellright] Ignore RegExp: \"' + settings.ignoreRegExps[i] + '\" malformed. Ignoring.');
                }
            }
        }

        if (settings.ignoreRegExpsByClass[languageid]) {
            for (var i = 0; i < settings.ignoreRegExpsByClass[languageid].length; i++) {
                try {
                    // Convert the JSON of RegExp Strings into a real RegExp
                    var flags = settings.ignoreRegExpsByClass[languageid][i].replace(/.*\/([gimy]*)$/, '$1');
                    var pattern = settings.ignoreRegExpsByClass[languageid][i].replace(new RegExp('^/(.*?)/' + flags + '$'), '$1');
                    if (SPELLRIGHT_DEBUG_OUTPUT) {
                        console.log('[spellright] RegExp prepare: by Class [' + languageid + ']: \"' + settings.ignoreRegExpsByClass[languageid][i] + ' = /' + pattern + '/' + flags);
                    }
                    this.ignoreRegExpsMap.push(new RegExp(pattern, flags));
                }
                catch (e) {
                    vscode.window.showErrorMessage('SpellRight: Ignore RexExp by Class [' + languageid + ']: \"' + settings.ignoreRegExpsByClass[languageid][i] + '\" malformed. Ignoring.');
                    if (SPELLRIGHT_DEBUG_OUTPUT) {
                        console.log('[spellright] Ignore RegExp: \"' + settings.ignoreRegExpsByClass[languageid][i] + '\" malformed. Ignoring.');
                    }
                }
            }
        }

        for (var i = 0; i < settings.latexSpellParameters.length; i++) {
            try {
                // Convert the JSON of RegExp Strings into a real RegExp
                if (SPELLRIGHT_DEBUG_OUTPUT) {
                    console.log('[spellright] RegExp prepare: ' + settings.latexSpellParameters[i] + ' = /^' + pattern + '$/' + '');
                }
                this.latexSpellParametersMap.push(new RegExp('^' + settings.latexSpellParameters[i] + '$', ''));
            }
            catch (e) {
                vscode.window.showErrorMessage('SpellRight: LaTeX Spell Parameters: \"' + settings.latexSpellParameters[i] + '\" malformed. Ignoring.');
                if (SPELLRIGHT_DEBUG_OUTPUT) {
                    console.log('[spellright] LaTeX Spell Parameters: \"' + settings.latexSpellParameters[i] + '\" malformed. Ignoring.');
                }
            }
        }
    };

    SpellRight.prototype.testIgnoreFile = function (uri) {

        // No workspace folder in this context
        if (!vscode.workspace.getWorkspaceFolder(uri)) {
            return false;
        }

        var uriwpath = vscode.workspace.getWorkspaceFolder(uri);
        var urifspath = uriwpath.uri.fsPath;

        // Silently ignore files defined by spellright.ignoreFiles
        if (helpers._ignoreFilesSettings.ignores(path.relative(urifspath, uri.fsPath)) || helpers._ignoreFilesSpellignore.ignores(path.relative(urifspath, uri.fsPath))) {
            return true;
        }

        // Test absolute path which is an extension to GitIgnore patterns
        var _absolute = false;
        helpers._ignoreFilesSettings._rules.forEach(function(_i) {
            if (path.relative(_i.pattern, uri.fsPath) === '') _absolute = true;
        });
        helpers._ignoreFilesSpellignore._rules.forEach(function(_i) {
            if (path.relative(_i.pattern, uri.fsPath) === '') _absolute = true;
        });
        if (_absolute)
            return true
        else
            return false;
    }

    SpellRight.prototype.getEffectiveLanguage = function () {
        // The hierarchy should be from topmost to lowest: In-Document Command,
        // Context, Default language chosen for spelling of the current word.

        if (this.spellingContext[0]._languageCommand.length > 0) {
            return this.spellingContext[0]._languageCommand;
        } else if (this.spellingContext[0]._languageContext.length > 0) {
            return this.spellingContext[0]._languageContext;
        } else {
            return this.spellingContext[0]._languageDefault;
        }
    };

    SpellRight.prototype.checkAndMarkCallback = function (document, context, diagnostics, token, linenumber, colnumber) {

        var _linenumber = linenumber;
        var _colnumber = colnumber;


        // Check if current context not disabled by syntatic control
        if (settings.spellContextByClass[document.languageId]) {
            if (settings.spellContextByClass[document.languageId].indexOf(context) == (-1)) {
                return;
            }
        } else if (settings.spellContext.indexOf(context) == (-1)) {
            return;
        }

        // Set language for the current syntactical context
        if (settings.languageContextByClass[document.languageId]) {
            this.spellingContext[0]._languageContext = this.readAsArray(settings.languageContextByClass[document.languageId][context]);
        } else if (settings.languageContext[context]) {
            this.spellingContext[0]._languageContext = this.readAsArray(settings.languageContext[context]);
        } else {
            this.spellingContext[0]._languageContext = [];
        }

        // Words are selected by language specific parsers but from here on
        // they are treated in the same way so these are operations done on
        // every word/lexem spelled.

        var cword = token.word;

        // Special case of words ending with period - abbreviations, etc.
        // Also cleanup for situations like: "peoples'." or LaTeX ""``up''".
        var _endsWithPeriod = cword.endsWith('.');
        var _startsWithPeriod = cword.startsWith('.');
        var _endsWithApostrophe = cword.endsWith('\'') || cword.endsWith('\u2019');
        while (cword.endsWith('.') || cword.endsWith('\'') || cword.endsWith('\u2019')) {
            _endsWithPeriod = cword.endsWith('.');
            _endsWithApostrophe = cword.endsWith('\'') || cword.endsWith('\u2019');

            cword = cword.slice(0, -1);
        }

        while (cword.startsWith('.') || cword.startsWith('\'')) {
            cword = cword.slice(1);
            _colnumber++;
        }
        var _containsPeriod = /[\.]/.test(cword);
        var _containsApostrophe = /[\'\u2019]/.test(cword);
        var _containsDash = /[-]/.test(cword);
        var _containsDigitInside = /\D\d\D/.test(cword);
        var _containsEmoji = /[\ue000-\uf8ff]|\ud83c[\udf00-\udfff]|\ud83d[\udc00-\ude4f]|\ud83d[\ude80-\udeff]/.test(cword);
        var _parentheticalPlural = /^\w+\((\w{1,2})\)$/.test(cword);
        var _containsParenthesis = /[\(\)]/.test(cword);
        var _possesiveApostrophe = /^\w+[\'\u2019]s$/.test(cword);

        // Detect placeholder replacement ("_") in used in markdown to
        // avoid false detection of indented code blocks in situation when
        // something is removed by regular expression or other rules.
        if (/_+/.test(cword)) {
            if (/_+/.exec(cword)[0].length == cword.length) return;
        }

        if (_parentheticalPlural) {
            // Here spell special case of parenthical plural (one or two
            // characters in parenthesis directly glued to the word, like
            // word(s), process(es) etc.)
            var ppmatch = /^(\w+)\((\w{1,2})\)$/;
            var match = ppmatch.exec(cword);
            cword = match[1];
        }

        if (!_parentheticalPlural && _containsParenthesis) {
            // Clean up after passing parenthesis for parentical plural
            cword = cword.replace(/\(/g, ' ');
            cword = cword.replace(/\)/g, ' ');
        }

        if (_possesiveApostrophe) {
            // Here spell special case of possesive 's
            var ppmatch = /^(\w+)[\'\u2019]s$/;
            var match = ppmatch.exec(cword);
            cword = match[1];
        }

        var _effectiveLanguages = this.getEffectiveLanguage();

        // Here check if the word is correct in ANY of the languages. If it is
        // then exit. If it is incorrect in ALL of them then proceed.
        for (var _li = 0; _li < _effectiveLanguages.length; _li++) {

            var _effectiveLanguage = _effectiveLanguages[_li];

            // Before splitting make sure word is not spelled correctly or on the
            // ignore list or regular expressions to ignore as a whole.
            if (!bindings.isMisspelled(cword)) {

                // Here word is spelled correctly or on the ignore list but there
                // are some special cases, like flaws in spelling engines.

                var _digitInsideOnWindows = false;

                // Some special cases are held here

                // Somehow Windows Spelling API considers anything with digit
                // inside a correctly spelled entity. Has to be corrected.
                if (_containsDigitInside && process.platform == 'win32') {
                    _digitInsideOnWindows = true;
                }

                // Do not exit if one of special cases
                if (!_digitInsideOnWindows) {
                    return;
                }
            }
        }

        // Split words containing period inside. Period does not break words
        // because it is part of legit abbreviations (e.g., i.e., etc.) which
        // should be spelled as well. So there can be lexems containing periods
        // inside. But they should be later on spelled as parts to minimize
        // the number of false positives. Same about apostrophe and few other
        // white/punctuation/graphical characters which are permitted above.
        var _split = this.splitByOtherWhite(cword);
        if (_split.length > 1) {

            // Heal "(inkl. " like sitautions here
            if (_endsWithPeriod) {
                _split[_split.length - 1].word = _split[_split.length - 1].word + '.';
            }
            var _this = this;
            _split.forEach (function(e) {
                if (e.word.length >= 2) {

                    var _token = { word: e.word, parent: cword, parser: token.parser };
                    var _source = '';
                    var _offset = e.offset;

                    if (token.map) {
                        _offset = 0;
                        for (var _i = 0; _i < e.offset; _i++) {
                            _offset += token.map[_i].length;
                        }
                        for (var _i = e.offset; _i < e.offset + e.word.length; _i++) {
                            _source += token.map[_i];
                        }
                        _token.source = _source;
                    }

                    _this.checkAndMarkCallback(document, context, diagnostics, _token, _linenumber, _colnumber + _offset);
                }
            });
            return;
        }

        // Deal with CamelCase
        _split = this.splitCamelCase(cword);
        if (_split.length > 1) {
            var _this = this;
            _split.forEach(function (e) {
                if (e.word.length >= 2) {

                    var _token = { word: e.word, parent: cword, parser: token.parser };
                    var _source = '';
                    var _offset = e.offset;

                    if (token.map) {
                        _offset = 0;
                        for (var _i = 0; _i < e.offset; _i++) {
                            _offset += token.map[_i].length;
                        }
                        for (var _i = e.offset; _i < e.offset + e.word.length; _i++) {
                            _source += token.map[_i];
                        }
                        _token.source = _source;
                    }

                    _this.checkAndMarkCallback(document, context, diagnostics, _token, _linenumber, _colnumber + _offset);
                }
            });
            return;
        }

        // Deal with snake_case
        _split = this.splitSnakeCase(cword);
        if (_split.length > 1) {
            var _this = this;
            _split.forEach(function (e) {
                if (e.word.length >= 2) {

                    var _token = { word: e.word, parent: cword, parser: token.parser };
                    var _source = '';
                    var _offset = e.offset;

                    if (token.map) {
                        _offset = 0;
                        for (var _i = 0; _i < e.offset; _i++) {
                            _offset += token.map[_i].length;
                        }
                        for (var _i = e.offset; _i < e.offset + e.word.length; _i++) {
                            _source += token.map[_i];
                        }
                        _token.source = _source;
                    }

                    _this.checkAndMarkCallback(document, context, diagnostics, _token, _linenumber, _colnumber + _offset);
                }
            });
            return;
        }

        // Punctuation cleaned version of the word

        for (var _li = 0; _li < _effectiveLanguages.length; _li++) {

            var _effectiveLanguage = _effectiveLanguages[_li];

            // Special case of words ending with period - if spelling
            // with dot at the end is correct contrary to spelling
            // without the dot then pass over.
            if (_endsWithPeriod) {
                if (!bindings.isMisspelled(cword + '.')) {
                    return;
                }
            }

            // Same case if it ends with apostrophe
            if (_endsWithApostrophe) {
                if (!bindings.isMisspelled(cword + '\'')) {
                    return;
                }
            }

            // Parenthesis e.g. brought by parenthical plurals
            if (_containsParenthesis) {
                if (!bindings.isMisspelled(cword.trim())) {
                    return;
                }
            }
        }

        if (_containsDash) {
            return;
        }

        if (token.source) {
            var _size = token.source.length;
        } else {
            var _size = cword.length;
        }

        // Avoid proposing a word with a dot to be added to dictionary
        if (_startsWithPeriod || _endsWithPeriod || _containsParenthesis) {
            token.word = cword;
        }

        var message = '\"' + cword + '\"';

        var hints = '';
        var hintCount = 0;

        if (SPELLRIGHT_DEBUG_OUTPUT) {
            message += ' (' + context + ')';
        }

        var range = new vscode.Range(_linenumber, _colnumber, _linenumber, _colnumber + _size);

        if (settings.suggestionsInHints) {

            for (var _li = 0; _li < _effectiveLanguages.length; _li++) {

                var _effectiveLanguage = _effectiveLanguages[_li];

                var suggestions = bindings.getCorrectionsForMisspelling(cword);

                hintCount += suggestions.length;

                if (suggestions.length > 0) {
                    if (helpers._commands.languages.length > 1 || helpers._commands.nlanguages.length > 0) {
                        hints += ' [' + _effectiveLanguage + ']: ';
                    } else {
                        hints += ': ';
                    }
                    for (var _i = 0, suggestions_1 = suggestions; _i < suggestions_1.length; _i++) {
                        var s = suggestions_1[_i];
                        hints += s + ', ';
                    }
                    hints = hints.slice(0, hints.length - 2);
                }
            }

            if (hintCount == 0) {
                message += ': no suggestions';
            } else {
                message += ': suggestions' + hints;
            }
    }

        var diagnosticsType = vscode.DiagnosticSeverity.Error;

        if (settings.notificationClass === 'warning') {
            diagnosticsType = vscode.DiagnosticSeverity.Warning;
        } else if (settings.notificationClass === 'information') {
            diagnosticsType = vscode.DiagnosticSeverity.Information;
        } else if (settings.notificationClass === 'hint') {
            diagnosticsType = vscode.DiagnosticSeverity.Hint;
        }

        if (settings.notificationClassByParser[token.parser] === 'warning') {
            diagnosticsType = vscode.DiagnosticSeverity.Warning;
        } else if (settings.notificationClassByParser[token.parser] === 'information') {
            diagnosticsType = vscode.DiagnosticSeverity.Information;
        } else if (settings.notificationClassByParser[token.parser] === 'hint') {
            diagnosticsType = vscode.DiagnosticSeverity.Hint;
        }

        var diag = new vscode.Diagnostic(range, message, diagnosticsType);
        diag.source = 'spelling';

        // Extend with context for actions provided in suggestions menu
        diag['token'] = token;
        diag['language'] = _effectiveLanguages;
        diag['context'] = context;
        diag['range'] = range;

        // Now insert diagnostics at the right place
        var append = false;
        if (diagnostics.length > 0) {
            var _drange = diagnostics[diagnostics.length - 1].range;
            // At the end if fits there
            append = (_linenumber > _drange._end._line ||
                (_linenumber == _drange._end._line &&
                _colnumber >= _drange._end._character));
        } else {
            // Definitely at the end!
            append = true;
        }

        if (append) {
            diagnostics.push(diag);
        } else {
            // Linear search. This should maybe be bisection or some
            // other algorithm in the future, but on the other hand
            // this code is called only on differential edits so there
            // are very few calls thus it should not degrade performance.
            for (var i = 0; i < diagnostics.length; i++) {
                var _drange = diagnostics[i].range;
                if (_drange._end.isBeforeOrEqual(diag.range.start))
                    continue;
                diagnostics.splice(i, 0, diag);
                break;
            }
        }
    }

    SpellRight.prototype.commandCallback = function (command, parameters) {
        if (this.spellingContext.length > 0) {
            if (command === 'on') {
                this.spellingContext[0]._enabled = true;
            } else if (command === 'off') {
                this.spellingContext[0]._enabled = false;
            }
        }
    }

    // Remove diagnostics in lines that were touched by change and in case
    // change brings any shift up/down - shift diagnostics.
    SpellRight.prototype.adjustDiagnostics = function (diagnostics, range, shift) {

        for (var i = diagnostics.length - 1; i >= 0; i--) {
            var _drange = diagnostics[i].range;
            if (_drange._start._line >= range._start._line &&
                _drange._end._line <= range._end._line) {
                // Remove diagnostics for changed lines range
                diagnostics.splice(i, 1);
            } else {
                // Adjust diagnostics behind changed lines range BEFORE
                if (shift != 0) {
                    if (_drange._end._line > range._end._line) {
                        diagnostics[i].range._start._line += shift;
                        diagnostics[i].range._end._line += shift;
                    }
                }
            }
        }
    }

    SpellRight.prototype.removeFromDiagnostics = function (diagnostics, word) {
        var _removed = 0;
        for (var j = diagnostics.length; j > 0 ; j--) {
            var _token = diagnostics[j - 1]['token'];
            if (_token.word === word || _token.parent === word) {
                diagnostics.splice(j - 1, 1);
                _removed++;
            }
        }
        return _removed;
    }

    SpellRight.prototype.doDiffSpellCheck = function (event) {

        var _document = event.document;

        helpers._commands.ignore = false;
        helpers._commands.force = false;

        var _this = this;

        var _languages = helpers._commands.languages.slice();
        var _nlanguages = helpers._commands.nlanguages.slice();

        this.getSettings(_document);

        // Is off for this document type?
        if (settings.documentTypes.indexOf(_document.languageId) == (-1)) {
            this.doCancelSpellCheck();
            indicator.updateStatusBarIndicator();
            this.diagnosticCollection.delete(_document.uri);
            this.diagnosticMap[_document.uri.toString()] = undefined;
            return;
        }

        // Is language set to "none"?
        if (settings.language == []) {
            return;
        }

        var _parser = doctype.fromDocument(settings, _document);

        if (_parser == null) {
            return
        };

        this.getDocumentSymbols(_document, _parser);

        var _return = { syntax: 0, linecount: 0 };
        var _signature = '';
        var _local_context = false;

        _return = _parser.parseForCommands(_document, { ignoreRegExpsMap: this.ignoreRegExpsMap, latexSpellParameters: this.latexSpellParametersMap }, function (command, parameters, range) {

            _signature = _signature + command + '-' + parameters;

            if (SPELLRIGHT_DEBUG_OUTPUT) {
                console.log('[spellright] In-Document Command: ' + command + ' [' + parameters + ']');
            }
            if (command === 'off') {
                helpers._commands.ignore = true;
            }
            if (command === 'on') {
                helpers._commands.force = true;
            }
        }, function (context) {
        });

        // .spellignore tested here so it can be overriden by InDoc command(s)
        if (this.testIgnoreFile(_document.uri)) {
            helpers._commands.ignore = true;
        }

        indicator.updateStatusBarIndicator();

        // Ignore spelling forced
        if (helpers._commands.ignore && !helpers._commands.force) {
            if (typeof this.diagnosticMap[_document.uri.toString()] !== 'undefined') {
                this.doCancelSpellCheck();
                this.diagnosticCollection.delete(_document.uri);
                this.diagnosticMap[_document.uri.toString()] = undefined;
            }
            return;
        }

        if (_languages.toString() !== helpers._commands.languages.toString()) {
            if (SPELLRIGHT_DEBUG_OUTPUT) {
                console.log('[spellright] In-Document language changed, rechecking');
            }
            this.doCancelSpellCheck();
            this.doInitiateSpellCheck(_document, true);
            return;
        } else if (typeof this.diagnosticMap[_document.uri.toString()] === 'undefined') {
            this.doInitiateSpellCheck(_document);
            return;
        }

        // If the document is being spelled (e.g. is large) adjust diagnostics
        // that are being prepared in the background, not those from the store.
        var diagnostics = [];

        if (this.spellingContext.length == 0) {
            diagnostics = this.diagnosticMap[_document.uri.toString()];

            // Create temporary context
            var _context = {
                _document: _document,
                _parser: _parser,
                _diagnostics: diagnostics,
                _line: 0,
                _start: Date.now(),
                _update: Date.now(),
                _languageDefault: settings.language.slice(),
                _languageContext: [],
                _languageCommand: [],
                _enabled: true
            };
            this.spellingContext.push(_context);
            _local_context = true;
        } else {
            diagnostics = this.spellingContext[0]._diagnostics;
        }

        // Calculate whether changes have shifted document lines up/down
        var shift = 0;

        for (var i = 0, l = event.contentChanges.length; i < l; i++) {
            var range = event.contentChanges[i].range;
            var _nlines = event.contentChanges[i].text.split(/\r?\n/).length - 1;
            shift = _nlines - (range.end.line - range.start.line);
        }

        // Main incremental spell check loop: check change affected
        for (var i = 0, l = event.contentChanges.length; i < l; i++) {
            var range = event.contentChanges[i].range;

            this.adjustDiagnostics(diagnostics, range, shift);

            _parser.spellCheckRange(_document, diagnostics, { ignoreRegExpsMap: this.ignoreRegExpsMap, latexSpellParameters: this.latexSpellParametersMap }, (_document, context, diagnostics, token, linenumber, colnumber) => this.checkAndMarkCallback(_document, context, diagnostics, token, linenumber, colnumber), (command, parameters) => this.commandCallback(command, parameters), range.start.line, range.start.character, range.end.line + shift, range.end.character);
        }

        // Spell check trail left after changes/jumps
        if (this.lastChanges !== null) {

            for (var i = 0, l = this.lastChanges.length; i < l; i++) {
                var range = this.lastChanges[i].range;

                for (var j = 0, k = event.contentChanges.length; j < k; j++) {
                    var erange = event.contentChanges[j].range;
                    // Exclude actually modified line from trail
                    if (!(erange.start.line >= range.start.line &&
                        erange.end.line <= range.start.line)) {

                        if (range.start.line <= erange.start.line ||
                            range.end.line <= erange.end.line) {
                            shift = 0;
                        }

                        var _range = new vscode.Range(range.start.line + shift, range.start.character, range.end.line + shift, range.end.character);
                        this.adjustDiagnostics(diagnostics, _range, 0);

                        _parser.spellCheckRange(_document, diagnostics, { ignoreRegExpsMap: this.ignoreRegExpsMap, latexSpellParameters: this.latexSpellParametersMap }, (_document, context, diagnostics, token, linenumber, colnumber) => this.checkAndMarkCallback(_document, context, diagnostics, token, linenumber, colnumber), (command, parameters) => this.commandCallback(command, parameters), range.start.line + shift, void 0, range.end.line + shift, void 0);
                    }
                }
            }
            this.lastChanges = null;
        }
        // Save it for next pass change/jump detection
        this.lastChanges = event.contentChanges;

        if (_local_context)
            this.spellingContext.shift();

        this.diagnosticMap[_document.uri.toString()] = diagnostics;
        this.diagnosticCollection.set(_document.uri, diagnostics.slice(0));

        if (helpers._commands.syntax != _return.syntax ||
            helpers._commands.signature !== _signature) {
            this.doCancelSpellCheck();
            helpers._commands.syntax = _return.syntax;
            helpers._commands.signature = _signature;
            this.doInitiateSpellCheck(_document);
        }
    };

    SpellRight.prototype.doRefreshConfiguration = function (event) {
        // Remove all diagnostics
        this.diagnosticCollection.clear();
        this.diagnosticMap = {};

        indicator.updateStatusBarIndicator();
        this.doInitiateSpellCheckVisible(true);
    }

    SpellRight.prototype.doInitiateSpellCheckVisible = function (force = false) {
        this.doCancelSpellCheck();
        if (vscode.window.activeTextEditor) {
            var _active = vscode.window.activeTextEditor.document;
            if (vscode.window.activeTextEditor && _active) {
                this.doInitiateSpellCheck(_active, force);
            }
            vscode.window.visibleTextEditors.forEach((editor, index) => {
                if (editor !== vscode.window.activeTextEditor) {
                    var _document = editor.document;
                    if (_document) {
                        this.doInitiateSpellCheck(_document, force);
                    }
                }
            });
        }
        indicator.updateStatusBarIndicator();
    }

    SpellRight.prototype.doInitiateSpellCheck = function (document, force = false) {

        var _document = document;

        helpers._commands.syntax = 0;
        helpers._commands.signature = '';
        helpers._commands.ignore = false;
        helpers._commands.force = false;

        var _this = this;

        this.getSettings(_document);

        // Is off for this document type?
        if (settings.documentTypes.indexOf(_document.languageId) == (-1)) {
            this.doCancelSpellCheck();
            indicator.updateStatusBarIndicator();
            this.diagnosticCollection.delete(_document.uri);
            this.diagnosticMap[_document.uri.toString()] = undefined;
            return;
        }

        // Is language set to "none"?
        if (settings.language == []) {
            return;
        }

        // Is this a private URI? (VSCode started having 'private:' versions
        // of non-plaintext documents with languageId = 'plaintext')
        if (_document.uri.scheme != 'file' && _document.uri.scheme != 'untitled') {
            return;
        }

        // Speller was already started && do not spell what's
        // already spelled, just diff watch differences
        var initiate = (this.spellingContext.length == 0);

        // Select appropriate parser
        const _parser = doctype.fromDocument(settings, _document);

        // No parser for this type of document
        if (_parser == null) {
            return;
        }

        this.getDocumentSymbols(_document, _parser);

        var _context = {
            _document: _document,
            _parser: _parser,
            _diagnostics: [],
            _line: 0,
            _start: Date.now(),
            _update: Date.now(),
            _languageDefault: settings.language.slice(),
            _languageContext: [],
            _languageCommand: [],
            _enabled: true
        };

        var _return = { syntax: 0, linecount: 0 };
        var _signature = '';

        var _length = this.spellingContext.length;

        _return = _parser.parseForCommands(_document, { ignoreRegExpsMap: this.ignoreRegExpsMap,
            latexSpellParameters: this.latexSpellParametersMap }, function (command, parameters, range) {

            _signature = command + '-' + parameters;

            if (SPELLRIGHT_DEBUG_OUTPUT) {
                console.log('[spellright] In-Document Command: ' + command + ' [' + parameters + ']');
            }
            if (command === 'off') {
                helpers._commands.ignore = true;
            }
            if (command === 'on') {
                helpers._commands.force = true;
            }
        }, function (context) {});

        helpers._commands.syntax = _return.syntax;
        helpers._commands.signature = _signature;

        // .spellignore tested here so it can be overriden by InDoc command(s)
        if (this.testIgnoreFile(_document.uri)) {
            helpers._commands.ignore = true;
        }

        indicator.updateStatusBarIndicator();

        // Ignore spelling forced
        if (helpers._commands.ignore && !helpers._commands.force) {
            if (typeof this.diagnosticMap[_document.uri.toString()] !== 'undefined') {
                this.diagnosticCollection.delete(_document.uri);
                this.diagnosticMap[_document.uri.toString()] = undefined;
            }
            return;
        }

        // Already spelled, needs cleaned diagnostics to respell
        if (this.diagnosticMap[_document.uri.toString()] !== undefined && !force) {
            return;
        }

        // The array spellingContext holds queue of documents to be spelled
        // successively. New documents are put in position 0 so that no matter
         // what was spelled a currently opened document will be spelled first.
        var _index = this.spellingContext.findIndex(e => e._document.uri === _context._document.uri);

        if (_index != -1) {
            // Move from position N to zero, only it it is not already on 0
            if (_index > 0) {
                this.spellingContext.splice(0, 0, this.spellingContext[_index]);
                this.spellingContext.splice(_index + 1, 1);
            }
        } else {
            this.spellingContext.splice(0, 0, _context);
        }

        if (SPELLRIGHT_DEBUG_OUTPUT) {
            console.log('[spellright] Spelling of \"' + _document.fileName + '\" [' + _document.languageId + '] STARTED.');
        }

        if (initiate) {
            // The rest is done "OnIdle" state
            setImmediate(function () { _this.doStepSpellCheck(_this) });
        }
    }

    SpellRight.prototype.doStepSpellCheck = function (_this) {

        var _return = { syntax: 0, linecount: 0 };

        if (_this.spellingContext.length == 0) {
            return;
        }

        if (_this.spellingContext[0]._line == 0) _this.spellingContext[0]._start = Date.now();

        var document = _this.spellingContext[0]._document;
        var parser = _this.spellingContext[0]._parser;
        var diagnostics = _this.spellingContext[0]._diagnostics;
        var line = _this.spellingContext[0]._line;
        var start = _this.spellingContext[0]._start;
        var update = _this.spellingContext[0]._update;

        if (line <= document.lineCount) {

            _return = parser.spellCheckRange(document, diagnostics, { ignoreRegExpsMap: this.ignoreRegExpsMap, latexSpellParameters: this.latexSpellParametersMap }, (document, context, diagnostics, token, linenumber, colnumber) => _this.checkAndMarkCallback(document, context, diagnostics, token, linenumber, colnumber), (command, parameters) => this.commandCallback(command, parameters), line, void 0, line + (SPELLRIGHT_LINES_BATCH - 1), void 0);

            // Update interface with already collected diagnostics
            if (this.updateInterval > 0) {
                if (Date.now() - update > this.updateInterval) {
                    _this.diagnosticMap[document.uri.toString()] = diagnostics;
                    _this.diagnosticCollection.set(document.uri, diagnostics.slice(0));

                    _this.spellingContext[0]._update = Date.now();
                }
            }

            // Push spelling a few lines forward
            _this.spellingContext[0]._line += SPELLRIGHT_LINES_BATCH;

        } else {
            _this.diagnosticMap[document.uri.toString()] = diagnostics;
            _this.diagnosticCollection.set(document.uri, diagnostics.slice(0));

            if (SPELLRIGHT_DEBUG_OUTPUT) {
                var secs = (Date.now() - start) / 1000;

                console.log('[spellright] Spelling of \"' + document.fileName + '\" [' + document.languageId + '] COMPLETED in ' + String(secs) + 's, ' + diagnostics.length + ' errors.');
            }

            // NULL document that has been finished
            _this.spellingContext.shift();
        }

        if (_this.spellingContext.length > 0) {
            setImmediate(function () { _this.doStepSpellCheck(_this, parser) });
        }
    }

    SpellRight.prototype.doCancelSpellCheck = function () {
        var _this = this;
        if (this.spellingContext[0] !== null) {
            this.spellingContext.forEach((context, index, array) => {
                _this.diagnosticMap[context._document.uri.toString()] = undefined;
                _this.diagnosticCollection.set(context._document.uri, []);

                if (SPELLRIGHT_DEBUG_OUTPUT) {
                    console.log('[spellright] Spelling of \"' + context._document.fileName + '\" [' + context._document.languageId + '] CANCELLED.');
                }

                _this.spellingContext.shift();
            });
        }
    };

    SpellRight.prototype.provideCodeActions = function (document, range, context, token) {

        var diagnostics = [];

        context.diagnostics.forEach(function (_diagnostics) {
            if (_diagnostics.source == 'spelling' && _diagnostics.range.contains(vscode.window.activeTextEditor.selection)) {
                diagnostics.push(_diagnostics);
            }
        });

        if (diagnostics == []) return null;

        if (settings.documentTypes.indexOf(document.languageId) == (-1) || (helpers._commands.ignore && !helpers._commands.force) || settings.language == []) {
            return null;
        }

        var commands = [];

        for (var _li = 0; _li < diagnostics.length; _li++) {

            var diagnostic = diagnostics[_li];

            var rmatch = /\"(.*)\"/;
            var match = rmatch.exec(diagnostic.message);
            var word = '';
            if (match.length >= 2)
                word = match[1];
            if (word.length == 0)
                return undefined;

            var token = diagnostic['token'];

            // Punctuation cleaned version of the word
            var cword = word.replace(/[.,]/g, '');

            if (SPELLRIGHT_DEBUG_OUTPUT) {
                console.log('[spellright] Providing code action for \"' + word + '\".');
            }

            var _effectiveLanguages = diagnostic['language'];

            for (var _li = 0; _li < _effectiveLanguages.length; _li++) {

                var _effectiveLanguage = _effectiveLanguages[_li];

                // Get suggestions

                if (helpers._commands.languages.length > 1 || helpers._commands.nlanguages.length > 0) {
                    var _language_info = ' [' + _effectiveLanguage + ']';
                } else {
                    var _language_info = '';
                }

                if (word && word.length >= 1) {
                    var suggestions = bindings.getCorrectionsForMisspelling(word);

                    // Add suggestions to command list
                    suggestions.forEach(function (suggestion) {
                        var action = new vscode.CodeAction(suggestion + _language_info);
                        action.kind = vscode.CodeActionKind.QuickFix;
                        action.edit = new vscode.WorkspaceEdit();
                        action.edit.replace(document.uri, diagnostic.range, suggestion);
                        commands.push(action);
                    });
                }
            }
        }

        return commands;
    };

    SpellRight.prototype.fixAll = function () {
        var editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        var document = editor.document;

        var diagnostics = this.diagnosticMap[document.uri.toString()];
        if(!diagnostics) {
            return;
        }

        diagnostics.forEach(function (_diagnostics) {
            if (_diagnostics.source == 'spelling' && _diagnostics.range.contains(vscode.window.activeTextEditor.selection)) {
                diagnostics.push(_diagnostics);
            }
        });

        if (diagnostics == []) return null;

        if (settings.documentTypes.indexOf(document.languageId) == (-1) || (helpers._commands.ignore && !helpers._commands.force) || settings.language == []) {
            return null;
        }

        asyncSeries(diagnostics, diagnostic => {
            var rmatch = /\"(.*)\"/;
            var match = rmatch.exec(diagnostic.message);
            var word = '';
            if (match.length >= 2)
                word = match[1];
            if (word.length == 0)
                return undefined;

            if (SPELLRIGHT_DEBUG_OUTPUT) {
                console.log('[spellright] Providing code action for \"' + word + '\".');
            }

            if (word && word.length >= 1) {
                var suggestions = bindings.getCorrectionsForMisspelling(word);

                return asyncSeries(suggestions, suggestion => {
                    var editFix = new vscode.WorkspaceEdit();
                    editFix.replace(document.uri, diagnostic.range, suggestion);
                    return vscode.workspace.applyEdit(editFix);
                });
            }
            return Promise.resolve();
        });
    };

    SpellRight.prototype.fixSuggestionCodeAction = function (document, diagnostic, word, suggestion) {
        var _word = document.getText(diagnostic.range);

        // Remove diagnostic from list
        var diagnostics = this.diagnosticMap[document.uri.toString()];
        var index = diagnostics.indexOf(diagnostic);
        diagnostics.splice(index, 1);

        // Update with new diagnostics
        this.diagnosticMap[document.uri.toString()] = diagnostics;
        this.diagnosticCollection.set(document.uri, diagnostics.slice(0));

        // This is a way to cope with abbreviations ("etc.", "i.e." etc.)
        // words ending with period are selected to spell with period but
        // this may lead to either a proper abbreviation ("etc.") with
        // period or with in a word or few words without period. Then it
        // has to be added to revert to original phrasing.
        if (word.endsWith('.') && !suggestion.endsWith('.')) {
            suggestion += '.';
        }

        // And other way around: Once original word does not contain dot at
        // the end and the suggestion (e.g. one out of many) contains dot,
        // remove it.
        if (suggestion.endsWith('.') && !word.endsWith('.')) {
            suggestion = suggestion.slice(0, -1);
        }

        // Insert the new text
        var edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, diagnostic.range, suggestion);
        return vscode.workspace.applyEdit(edit);
    };

    SpellRight.prototype.getDocumentSymbols = async function (document, parser) {

        var _this = this;
        var _DocumentSymbols = [];

        if (settings.useDocumentSymbolsInCode && parser.constructor.name === 'Code') {
            const symbols = vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri).then(function (symbols) {
                if (symbols) {
                    _DocumentSymbols = Object.values(symbols).map(e => { return e.name; });
                    var _removed = 0;

                    // Remove diagnostics refering to just loaded symbols
                    // because we are already spelling.
                    if (typeof _this.diagnosticMap[document.uri.toString()] !== 'undefined') {
                        var diagnostics = _this.diagnosticMap[document.uri.toString()];
                        for (var i = 0; i < _DocumentSymbols.length; i++) {
                            _removed += _this.removeFromDiagnostics(diagnostics, _DocumentSymbols[i]);
                        }
                    }

                    if (SPELLRIGHT_DEBUG_OUTPUT) {
                            console.log('[spellright] Loaded ' + _DocumentSymbols.length + ' document symbols, removed ' + _removed + ' of ' + diagnostics.length + ' symbols.');
                    }

                    helpers._DocumentSymbols = _DocumentSymbols;
                } else {
                    helpers._DocumentSymbols = [];
                }
            });
        } else {
            helpers._DocumentSymbols = [];
        }
    }

    SpellRight.prototype.getUniqueArray = function (array) {
        var a = array.concat();
        for (var i = 0; i < a.length; ++i) {
            for (var j = i + 1; j < a.length; ++j) {
                if (a[i] === a[j])
                    a.splice(j--, 1);
            }
        }
        return a;
    };

    SpellRight.prototype.getSettingsScope = function (uri) {
        if (vscode.workspace.getWorkspaceFolder(uri)) {
            if (settings.configurationScope == 'user') {
                return vscode.ConfigurationTarget.Global;
            } else {
                return vscode.ConfigurationTarget.WorkspaceFolder;
            }
        } else {
            if (vscode.workspace.workspaceFolders) {
                // Out of workspace document opened IN WORKSPACE
                if (settings.configurationScope == 'user') {
                    return vscode.ConfigurationTarget.Global;
                } else {
                return vscode.ConfigurationTarget.Workspace;
                }
            } else {
                // Out of workspace document opened STANDALONE
                return vscode.ConfigurationTarget.Global;
            }
        }
    };

    SpellRight.prototype.readIgnoreFile = function (ipath) {
        var ifile = path.join(ipath, '.spellignore');
        var result = ignore();
        var count = 0;

        if (fs.existsSync(ifile)) {
            result.add(fs.readFileSync(ifile, 'utf-8'));
            count++;
        }

        if (SPELLRIGHT_DEBUG_OUTPUT) {
            console.log('[spellright] Read ' + count + ' pattern(s) from \"' + ifile + '\" file.');
        }
        return result;
    }

    SpellRight.prototype.readAsArray = function (_language) {
        // Correct old style configuration (string to array)
        if (Array.isArray(_language)) {
            return _language;
        } else {
            return [_language];
        }
    }

    // Adapted from https://github.com/elgs/splitargs
    SpellRight.prototype.splitParams = function (input, sep, keepQuotes) {
        var separator = sep || /\s/g;
        var singleQuoteOpen = false;
        var doubleQuoteOpen = false;
        var tokenBuffer = [];
        var ret = [];

        var arr = input.split('');
        for (var i = 0; i < arr.length; ++i) {
            var element = arr[i];
            var matches = element.match(separator);
            if (element === "'" && !doubleQuoteOpen) {
                if (keepQuotes === true) {
                    tokenBuffer.push(element);
                }
                singleQuoteOpen = !singleQuoteOpen;
                continue;
            } else if (element === '"' && !singleQuoteOpen) {
                if (keepQuotes === true) {
                    tokenBuffer.push(element);
                }
                doubleQuoteOpen = !doubleQuoteOpen;
                continue;
            }

            if (!singleQuoteOpen && !doubleQuoteOpen && matches) {
                if (tokenBuffer.length > 0) {
                    ret.push(tokenBuffer.join(''));
                    tokenBuffer = [];
                } else if (!!sep) {
                    ret.push(element);
                }
            } else {
                tokenBuffer.push(element);
            }
        }
        if (tokenBuffer.length > 0) {
            ret.push(tokenBuffer.join(''));
        } else if (!!sep) {
            ret.push('');
        }
        return ret;
    }

    SpellRight.prototype.getSettings = function (document = undefined) {
        var uri = undefined;
        var languageid = undefined;
        var uriwpath = undefined;
        var urifspath = '';

        if (document !== undefined) {
            uri = document.uri;
            languageid = document.languageId;
            uriwpath = vscode.workspace.getWorkspaceFolder(uri);
            if (uriwpath !== undefined)
                urifspath = uriwpath.uri.fsPath;
        }

        var _settings = vscode.workspace.getConfiguration('spellright', uri);
        for (var p in _settings) settings[p] = _settings[p];
        settings.language = this.readAsArray(_settings.language);
        settings.parserByClass = Object.assign({}, _settings.parserByClass);

        this.selectDefaultLanguage();

        helpers._commands.languages = [];
        helpers._commands.nlanguages = [];

        var _this = this;

        /*
        settings.language.slice().forEach(function (_parameter) {
            if (_this.checkDictionary(_parameter)) {
                helpers._commands.languages.push(_parameter);
            } else {
                parser.pushIfNotExist(helpers._commands.nlanguages, _parameter, function (e) {
                    return e === _parameter;
                });
            }
        });
        */

        this.prepareIgnoreRegExps(languageid);

        helpers._ignoreFilesSettings = ignore();
        settings.ignoreFiles.forEach(function (key) {
            helpers._ignoreFilesSettings.add(key);
        });


        // Here loading workspace "per resource" dictionaries
        if (uri && vscode.workspace.getWorkspaceFolder(uri)) {
            helpers._ignoreFilesSpellignore = this.readIgnoreFile(urifspath);
        }

        return;
    };

    SpellRight.suggestCommandId = 'spellright.fixSuggestionCodeAction';

    SpellRight.CONFIGFILE = '';
    SpellRight.IGNOREFILE = '';

    return SpellRight;
}());

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = SpellRight;

var SpellRightIndicator = (function () {
    function SpellRightIndicator() {
    };
    SpellRightIndicator.prototype.dispose = function () {
        this.hideLanguage();
    };

    SpellRightIndicator.prototype.updateStatusBarIndicator = function () {
        var location = vscode.StatusBarAlignment.Right;
        var priority = SPELLRIGHT_STATUSBAR_ITEM_PRIORITY;

        if (!this.statusBarItem) {
            this.statusBarItem = vscode.window.createStatusBarItem(location, priority);
        }
        // Get the current text editor
        var editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.statusBarItem.hide();
            return;
        }
        var document = editor.document;

        var message = '';
        var color = 'default';
        var tooltip = 'Spelling - ';

        var _this = this;

        if (settings.language.length == 1) {
            if (SPELLRIGHT_DEBUG_OUTPUT) {
                message = message + ' [' + settings.language[0] + ']';
            }
        }

        if (settings.documentTypes.indexOf(document.languageId) == (-1) || (helpers._commands.ignore && !helpers._commands.force)) {
            message = '[off]';
            if (helpers._commands.ignore && !helpers._commands.force) {
                color = '#ff5858';
                tooltip = tooltip + 'Forced OFF';
            } else {
                tooltip = tooltip + 'OFF';
            }
        } else {
            if (settings.language == []) {
                message = '[none]';
                tooltip = tooltip + 'No Language Selected';
            } else if (helpers._commands.languages.length == 0 && helpers._commands.nlanguages.length == 1) {
                color = '#ff5858';
                tooltip = tooltip + '[unknown language]';
            } else if (helpers._commands.languages.length + helpers._commands.nlanguages.length > 1) {
                message = '[multi]';
                tooltip = tooltip + 'Multiple Languages';
                tooltip = tooltip + ' [';
                if (helpers._commands.languages.length > 0) {
                    helpers._commands.languages.forEach(function (entry, i, a) {
                        if (i !== a.length - 1) tooltip = tooltip + ', ';
                    });
                    if (helpers._commands.nlanguages.length > 0) {
                        tooltip = tooltip + ', ';
                    }
                }
                if (helpers._commands.nlanguages.length > 0) {
                    color = '#ff5858';
                    tooltip = tooltip + 'unknown: ';
                    helpers._commands.nlanguages.forEach(function (entry, i, a) {
                        if (i !== a.length - 1) tooltip = tooltip + ', ';
                    });
                }
                tooltip = tooltip + ']';
            } else {
                tooltip = tooltip + 'ON';
            }
        }

        this.statusBarItem.text = '$(eye) ' + message;
        this.statusBarItem.color = color;
        this.statusBarItem.tooltip = tooltip;

        if (settings.statusBarIndicator) {
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    };
    SpellRightIndicator.prototype.isLanguage = function (document) {
        var filePath = document.fileName;
        try {
            fs.accessSync(filePath, fs.W_OK);
            return false;
        }
        catch (error) {
            return true;
        }
    };
    SpellRightIndicator.prototype.hideLanguage = function () {
        if (this.statusBarItem) {
            this.statusBarItem.dispose();
        }
    };
    return SpellRightIndicator;
}());

exports.SpellRightIndicator = SpellRightIndicator;

var SpellRightIndicatorController = (function () {
    function SpellRightIndicatorController(idicator) {
        this.SpellRightIndicator = idicator;
        this.SpellRightIndicator.updateStatusBarIndicator();
        // subscribe to selection change and editor activation events
        var subscriptions = [];
        vscode.window.onDidChangeTextEditorSelection(this.onEvent, this, subscriptions);
        vscode.window.onDidChangeActiveTextEditor(this.onEvent, this, subscriptions);
        // create a combined disposable from both event subscriptions
        this.disposable = vscode.Disposable.from.apply(vscode.Disposable, subscriptions);
    };
    SpellRightIndicatorController.prototype.dispose = function () {
        this.disposable.dispose();
    };
    SpellRightIndicatorController.prototype.onEvent = function () {
        this.SpellRightIndicator.updateStatusBarIndicator();
    };
    return SpellRightIndicatorController;
}());

exports.SpellRightIndicatorController = SpellRightIndicatorController;
