/**
 * @license
 * Copyright (C) 2016 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
(function(window, GrDiffGroup, GrDiffLine) {
  'use strict';

  // Prevent redefinition.
  if (window.GrDiffBuilder) { return; }

  /** @enum {string} */
  Gerrit.DiffSide = {
    LEFT: 'left',
    RIGHT: 'right',
    BOTH: 'both',
  };

  /**
   * @param {!Array<!HTMLElement>} threadEls
   * @param {!{beforeNumber: (number|string|undefined),
   *           afterNumber: (number|string|undefined)}}
   *     lineInfo
   * @param {!Gerrit.DiffSide=} side The side (LEFT, RIGHT, BOTH) for
   *     which to return the threads (default: BOTH).
   * @return {!Array<!HTMLElement>} The thread elements matching the given
   *     location.
   */
  Gerrit.filterThreadElsForLocation = function(
      threadEls, lineInfo, side = Gerrit.DiffSide.BOTH) {
    function matchesLeftLine(threadEl) {
      return threadEl.getAttribute('comment-side') ==
          Gerrit.DiffSide.LEFT &&
          threadEl.getAttribute('line-num') == lineInfo.beforeNumber;
    }
    function matchesRightLine(threadEl) {
      return threadEl.getAttribute('comment-side') ==
          Gerrit.DiffSide.RIGHT &&
          threadEl.getAttribute('line-num') == lineInfo.afterNumber;
    }
    function matchesFileComment(threadEl) {
      return (side === Gerrit.DiffSide.BOTH ||
              threadEl.getAttribute('comment-side') == side) &&
            // line/range comments have 1-based line set, if line is falsy it's
            // a file comment
            !threadEl.getAttribute('line-num');
    }

    // Select the appropriate matchers for the desired side and line
    // If side is BOTH, we want both the left and right matcher.
    const matchers = [];
    if (side !== Gerrit.DiffSide.RIGHT) {
      matchers.push(matchesLeftLine);
    }
    if (side !== Gerrit.DiffSide.LEFT) {
      matchers.push(matchesRightLine);
    }
    if (lineInfo.afterNumber === 'FILE' ||
        lineInfo.beforeNumber === 'FILE') {
      matchers.push(matchesFileComment);
    }
    return threadEls.filter(threadEl =>
        matchers.some(matcher => matcher(threadEl)));
  };

  /**
   * In JS, unicode code points above 0xFFFF occupy two elements of a string.
   * For example '𐀏'.length is 2. An occurence of such a code point is called a
   * surrogate pair.
   *
   * This regex segments a string along tabs ('\t') and surrogate pairs, since
   * these are two cases where '1 char' does not automatically imply '1 column'.
   *
   * TODO: For human languages whose orthographies use combining marks, this
   * approach won't correctly identify the grapheme boundaries. In those cases,
   * a grapheme consists of multiple code points that should count as only one
   * character against the column limit. Getting that correct (if it's desired)
   * is probably beyond the limits of a regex, but there are nonstandard APIs to
   * do this, and proposed (but, as of Nov 2017, unimplemented) standard APIs.
   *
   * Further reading:
   *   On Unicode in JS: https://mathiasbynens.be/notes/javascript-unicode
   *   Graphemes: http://unicode.org/reports/tr29/#Grapheme_Cluster_Boundaries
   *   A proposed JS API: https://github.com/tc39/proposal-intl-segmenter
   */
  const REGEX_TAB_OR_SURROGATE_PAIR = /\t|[\uD800-\uDBFF][\uDC00-\uDFFF]/;

  function GrDiffBuilder(diff, comments, parentIndex, changeNum, path,
      projectName, prefs, outputEl, layers) {
    this._diff = diff;
    this._comments = comments;
    this._parentIndex = parentIndex;
    this._changeNum = changeNum;
    this._path = path;
    this._projectName = projectName;
    this._prefs = prefs;
    this._outputEl = outputEl;
    this.groups = [];
    this._blameInfo = null;

    this.layers = layers || [];

    if (isNaN(prefs.tab_size) || prefs.tab_size <= 0) {
      throw Error('Invalid tab size from preferences.');
    }

    if (isNaN(prefs.line_length) || prefs.line_length <= 0) {
      throw Error('Invalid line length from preferences.');
    }

    for (const layer of this.layers) {
      if (layer.addListener) {
        layer.addListener(this._handleLayerUpdate.bind(this));
      }
    }

    if (!this._comments) {
      this._threadEls = [];
      return;
    }

    const allComments = [];
    for (const side of [GrDiffBuilder.Side.LEFT, GrDiffBuilder.Side.RIGHT]) {
      // This is needed by the threading.
      for (const comment of this._comments[side]) {
        comment.__commentSide = side;
      }
      allComments.push(...this._comments[side]);
    }
    const threads = this._createThreads(allComments);
    this._threadEls = threads.map(thread => {
      // TODO(oler): Figure out how to determine that here already - for now,
      //             this is set later.
      const isOnParent = false;
      return Gerrit.createThreadElement(
          thread, isOnParent, this._parentIndex, this._changeNum,
          this._path, this._projectName);
    });
  }

  GrDiffBuilder.GroupType = {
    ADDED: 'b',
    BOTH: 'ab',
    REMOVED: 'a',
  };

  GrDiffBuilder.Highlights = {
    ADDED: 'edit_b',
    REMOVED: 'edit_a',
  };

  GrDiffBuilder.Side = {
    LEFT: 'left',
    RIGHT: 'right',
  };

  GrDiffBuilder.ContextButtonType = {
    ABOVE: 'above',
    BELOW: 'below',
    ALL: 'all',
  };

  const PARTIAL_CONTEXT_AMOUNT = 10;

  /**
   * Abstract method
   * @param {string} outputEl
   * @param {number} fontSize
   */
  GrDiffBuilder.prototype.addColumns = function() {
    throw Error('Subclasses must implement addColumns');
  };

  /**
   * Abstract method
   * @param {Object} group
   */
  GrDiffBuilder.prototype.buildSectionElement = function() {
    throw Error('Subclasses must implement buildSectionElement');
  };

  GrDiffBuilder.prototype.emitGroup = function(group, opt_beforeSection) {
    const element = this.buildSectionElement(group);
    this._outputEl.insertBefore(element, opt_beforeSection);
    group.element = element;
  };

  GrDiffBuilder.prototype.renderSection = function(element) {
    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i];
      if (group.element === element) {
        const newElement = this.buildSectionElement(group);
        group.element.parentElement.replaceChild(newElement, group.element);
        group.element = newElement;
        break;
      }
    }
  };

  GrDiffBuilder.prototype.getGroupsByLineRange = function(
      startLine, endLine, opt_side) {
    const groups = [];
    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i];
      if (group.lines.length === 0) {
        continue;
      }
      let groupStartLine = 0;
      let groupEndLine = 0;
      if (opt_side) {
        groupStartLine = group.lineRange[opt_side].start;
        groupEndLine = group.lineRange[opt_side].end;
      }

      if (groupStartLine === 0) { // Line was removed or added.
        groupStartLine = groupEndLine;
      }
      if (groupEndLine === 0) { // Line was removed or added.
        groupEndLine = groupStartLine;
      }
      if (startLine <= groupEndLine && endLine >= groupStartLine) {
        groups.push(group);
      }
    }
    return groups;
  };

  GrDiffBuilder.prototype.getContentByLine = function(lineNumber, opt_side,
      opt_root) {
    const root = Polymer.dom(opt_root || this._outputEl);
    const sideSelector = opt_side ? ('.' + opt_side) : '';
    return root.querySelector('td.lineNum[data-value="' + lineNumber +
        '"]' + sideSelector + ' ~ td.content .contentText');
  };

  /**
   * Find line elements or line objects by a range of line numbers and a side.
   *
   * @param {number} start The first line number
   * @param {number} end The last line number
   * @param {string} opt_side The side of the range. Either 'left' or 'right'.
   * @param {!Array<GrDiffLine>} out_lines The output list of line objects. Use
   *     null if not desired.
   * @param  {!Array<HTMLElement>} out_elements The output list of line elements.
   *     Use null if not desired.
   */
  GrDiffBuilder.prototype.findLinesByRange = function(start, end, opt_side,
      out_lines, out_elements) {
    const groups = this.getGroupsByLineRange(start, end, opt_side);
    for (const group of groups) {
      let content = null;
      for (const line of group.lines) {
        if ((opt_side === 'left' && line.type === GrDiffLine.Type.ADD) ||
            (opt_side === 'right' && line.type === GrDiffLine.Type.REMOVE)) {
          continue;
        }
        const lineNumber = opt_side === 'left' ?
            line.beforeNumber : line.afterNumber;
        if (lineNumber < start || lineNumber > end) { continue; }

        if (out_lines) { out_lines.push(line); }
        if (out_elements) {
          if (content) {
            content = this._getNextContentOnSide(content, opt_side);
          } else {
            content = this.getContentByLine(lineNumber, opt_side,
                group.element);
          }
          if (content) { out_elements.push(content); }
        }
      }
    }
  };

  /**
   * Re-renders the DIV.contentText elements for the given side and range of
   * diff content.
   */
  GrDiffBuilder.prototype._renderContentByRange = function(start, end, side) {
    const lines = [];
    const elements = [];
    let line;
    let el;
    this.findLinesByRange(start, end, side, lines, elements);
    for (let i = 0; i < lines.length; i++) {
      line = lines[i];
      el = elements[i];
      if (!el) {
        // Cannot re-render an element if it does not exist. This can happen
        // if lines are collapsed and not visible on the page yet.
        continue;
      }
      el.parentElement.replaceChild(this._createTextEl(line, side).firstChild,
          el);
    }
  };

  GrDiffBuilder.prototype.getSectionsByLineRange = function(
      startLine, endLine, opt_side) {
    return this.getGroupsByLineRange(startLine, endLine, opt_side).map(
        group => { return group.element; });
  };

  // TODO(wyatta): Move this completely into the processor.
  GrDiffBuilder.prototype._insertContextGroups = function(groups, lines,
      hiddenRange) {
    const linesBeforeCtx = lines.slice(0, hiddenRange[0]);
    const hiddenLines = lines.slice(hiddenRange[0], hiddenRange[1]);
    const linesAfterCtx = lines.slice(hiddenRange[1]);

    if (linesBeforeCtx.length > 0) {
      groups.push(new GrDiffGroup(GrDiffGroup.Type.BOTH, linesBeforeCtx));
    }

    const ctxLine = new GrDiffLine(GrDiffLine.Type.CONTEXT_CONTROL);
    ctxLine.contextGroup =
        new GrDiffGroup(GrDiffGroup.Type.BOTH, hiddenLines);
    groups.push(new GrDiffGroup(GrDiffGroup.Type.CONTEXT_CONTROL,
        [ctxLine]));

    if (linesAfterCtx.length > 0) {
      groups.push(new GrDiffGroup(GrDiffGroup.Type.BOTH, linesAfterCtx));
    }
  };

  GrDiffBuilder.prototype._createContextControl = function(section, line) {
    if (!line.contextGroup || !line.contextGroup.lines.length) {
      return null;
    }

    const td = this._createElement('td');
    const showPartialLinks =
        line.contextGroup.lines.length > PARTIAL_CONTEXT_AMOUNT;

    if (showPartialLinks) {
      td.appendChild(this._createContextButton(
          GrDiffBuilder.ContextButtonType.ABOVE, section, line));
      td.appendChild(document.createTextNode(' - '));
    }

    td.appendChild(this._createContextButton(
        GrDiffBuilder.ContextButtonType.ALL, section, line));

    if (showPartialLinks) {
      td.appendChild(document.createTextNode(' - '));
      td.appendChild(this._createContextButton(
          GrDiffBuilder.ContextButtonType.BELOW, section, line));
    }

    return td;
  };

  GrDiffBuilder.prototype._createContextButton = function(type, section, line) {
    const contextLines = line.contextGroup.lines;
    const context = PARTIAL_CONTEXT_AMOUNT;

    const button = this._createElement('gr-button', 'showContext');
    button.setAttribute('link', true);
    button.setAttribute('no-uppercase', true);

    let text;
    const groups = []; // The groups that replace this one if tapped.

    if (type === GrDiffBuilder.ContextButtonType.ALL) {
      text = 'Show ' + contextLines.length + ' common line';
      if (contextLines.length > 1) { text += 's'; }
      groups.push(line.contextGroup);
    } else if (type === GrDiffBuilder.ContextButtonType.ABOVE) {
      text = '+' + context + '↑';
      this._insertContextGroups(groups, contextLines,
          [context, contextLines.length]);
    } else if (type === GrDiffBuilder.ContextButtonType.BELOW) {
      text = '+' + context + '↓';
      this._insertContextGroups(groups, contextLines,
          [0, contextLines.length - context]);
    }

    Polymer.dom(button).textContent = text;

    button.addEventListener('tap', e => {
      e.detail = {
        groups,
        section,
      };
      // Let it bubble up the DOM tree.
    });

    return button;
  };

  /**
   * @param {Array<Object>} comments
   */
  GrDiffBuilder.prototype._createThreads = function(comments) {
    const sortedComments = comments.slice(0).sort((a, b) => {
      if (b.__draft && !a.__draft ) { return 0; }
      if (a.__draft && !b.__draft ) { return 1; }
      return util.parseDate(a.updated) - util.parseDate(b.updated);
    });

    const threads = [];
    for (const comment of sortedComments) {
      // If the comment is in reply to another comment, find that comment's
      // thread and append to it.
      if (comment.in_reply_to) {
        const thread = threads.find(thread =>
            thread.comments.some(c => c.id === comment.in_reply_to));
        if (thread) {
          thread.comments.push(comment);
          continue;
        }
      }

      // Otherwise, this comment starts its own thread.
      const newThread = {
        start_datetime: comment.updated,
        comments: [comment],
        commentSide: comment.__commentSide,
        patchNum: comment.patch_set,
        rootId: comment.id || comment.__draftID,
        lineNum: comment.line,
      };
      if (comment.range) {
        newThread.range = Object.assign({}, comment.range);
      }
      threads.push(newThread);
    }
    return threads;
  };

  /**
   * Returns the patch number that new comment threads should be attached to.
   *
   * @param {GrDiffLine} line The line new thread will be attached to.
   * @param {string=} opt_side Set to LEFT to force adding it to the LEFT side -
   *     will be ignored if the left is a parent or a merge parent
   * @return {number} Patch set to attach the new thread to
   */
  GrDiffBuilder.prototype._determinePatchNumForNewThreads = function(
      patchRange, line, opt_side) {
    if ((line.type === GrDiffLine.Type.REMOVE ||
         opt_side === GrDiffBuilder.Side.LEFT) &&
        patchRange.basePatchNum !== 'PARENT' &&
        !Gerrit.PatchSetBehavior.isMergeParent(patchRange.basePatchNum)) {
      return patchRange.basePatchNum;
    } else {
      return patchRange.patchNum;
    }
  };

  /**
   * Returns whether the comments on the given line are on a (merge) parent.
   *
   * @param {string} firstCommentSide
   * @param {{basePatchNum: number, patchNum: number}} patchRange
   * @param {GrDiffLine} line The line the comments are on.
   * @param {string=} opt_side
   * @return {boolean} True iff the comments on the given line are on a (merge)
   *    parent.
   */
  GrDiffBuilder.prototype._determineIsOnParent = function(
      firstCommentSide, patchRange, line, opt_side) {
    return ((line.type === GrDiffLine.Type.REMOVE ||
             opt_side === GrDiffBuilder.Side.LEFT) &&
            (patchRange.basePatchNum === 'PARENT' ||
             Gerrit.PatchSetBehavior.isMergeParent(
                 patchRange.basePatchNum))) ||
          firstCommentSide === 'PARENT';
  };

  /**
   * @param {!GrDiffLine} line
   * @param {!GrDiffBuilder.Side=} side The side (LEFT, RIGHT, BOTH) for which to return
   *     the thread group (default: BOTH).
   * @return {!Object}
   */
  GrDiffBuilder.prototype._commentThreadGroupForLine = function(
      line, side = GrDiffBuilder.Side.BOTH) {
    const threadElsForGroup =
        Gerrit.filterThreadElsForLocation(this._threadEls, line, side);
    if (!threadElsForGroup || threadElsForGroup.length === 0) {
      return null;
    }

    const threadGroupEl =
        document.createElement('gr-diff-comment-thread-group');
    const patchRange = this._comments.meta.patchRange;
    for (const threadEl of threadElsForGroup) {
      threadEl.isOnParent = this._determineIsOnParent(
          threadEl.comments[0].side, patchRange, line, side);
      Polymer.dom(threadGroupEl).appendChild(threadEl);
    }
    if (side) {
      threadGroupEl.setAttribute('data-side', side);
    }
    return threadGroupEl;
  };

  GrDiffBuilder.prototype._createLineEl = function(
      line, number, type, opt_class) {
    const td = this._createElement('td');
    if (opt_class) {
      td.classList.add(opt_class);
    }

    if (line.type === GrDiffLine.Type.REMOVE) {
      td.setAttribute('aria-label', `${number} removed`);
    } else if (line.type === GrDiffLine.Type.ADD) {
      td.setAttribute('aria-label', `${number} added`);
    }

    if (line.type === GrDiffLine.Type.BLANK) {
      return td;
    } else if (line.type === GrDiffLine.Type.CONTEXT_CONTROL) {
      td.classList.add('contextLineNum');
      td.setAttribute('data-value', '@@');
      td.textContent = '@@';
    } else if (line.type === GrDiffLine.Type.BOTH || line.type === type) {
      td.classList.add('lineNum');
      td.setAttribute('data-value', number);
      td.textContent = number === 'FILE' ? 'File' : number;
    }
    return td;
  };

  GrDiffBuilder.prototype._createTextEl = function(line, opt_side) {
    const td = this._createElement('td');
    if (line.type !== GrDiffLine.Type.BLANK) {
      td.classList.add('content');
    }
    td.classList.add(line.type);

    const lineLimit =
        !this._prefs.line_wrapping ? this._prefs.line_length : Infinity;

    const contentText =
        this._formatText(line.text, this._prefs.tab_size, lineLimit);
    if (opt_side) {
      contentText.setAttribute('data-side', opt_side);
    }

    for (const layer of this.layers) {
      layer.annotate(contentText, line);
    }

    td.appendChild(contentText);

    return td;
  };

  /**
   * Returns a 'div' element containing the supplied |text| as its innerText,
   * with '\t' characters expanded to a width determined by |tabSize|, and the
   * text wrapped at column |lineLimit|, which may be Infinity if no wrapping is
   * desired.
   *
   * @param {string} text The text to be formatted.
   * @param {number} tabSize The width of each tab stop.
   * @param {number} lineLimit The column after which to wrap lines.
   * @return {HTMLElement}
   */
  GrDiffBuilder.prototype._formatText = function(text, tabSize, lineLimit) {
    const contentText = this._createElement('div', 'contentText');

    let columnPos = 0;
    let textOffset = 0;
    for (const segment of text.split(REGEX_TAB_OR_SURROGATE_PAIR)) {
      if (segment) {
        // |segment| contains only normal characters. If |segment| doesn't fit
        // entirely on the current line, append chunks of |segment| followed by
        // line breaks.
        let rowStart = 0;
        let rowEnd = lineLimit - columnPos;
        while (rowEnd < segment.length) {
          contentText.appendChild(
              document.createTextNode(segment.substring(rowStart, rowEnd)));
          contentText.appendChild(this._createElement('span', 'br'));
          columnPos = 0;
          rowStart = rowEnd;
          rowEnd += lineLimit;
        }
        // Append the last part of |segment|, which fits on the current line.
        contentText.appendChild(
            document.createTextNode(segment.substring(rowStart)));
        columnPos += (segment.length - rowStart);
        textOffset += segment.length;
      }
      if (textOffset < text.length) {
        // Handle the special character at |textOffset|.
        if (text.startsWith('\t', textOffset)) {
          // Append a single '\t' character.
          let effectiveTabSize = tabSize - (columnPos % tabSize);
          if (columnPos + effectiveTabSize > lineLimit) {
            contentText.appendChild(this._createElement('span', 'br'));
            columnPos = 0;
            effectiveTabSize = tabSize;
          }
          contentText.appendChild(this._getTabWrapper(effectiveTabSize));
          columnPos += effectiveTabSize;
          textOffset++;
        } else {
          // Append a single surrogate pair.
          if (columnPos >= lineLimit) {
            contentText.appendChild(this._createElement('span', 'br'));
            columnPos = 0;
          }
          contentText.appendChild(document.createTextNode(
              text.substring(textOffset, textOffset + 2)));
          textOffset += 2;
          columnPos += 1;
        }
      }
    }
    return contentText;
  };

  /**
   * Returns a <span> element holding a '\t' character, that will visually
   * occupy |tabSize| many columns.
   *
   * @param {number} tabSize The effective size of this tab stop.
   * @return {HTMLElement}
   */
  GrDiffBuilder.prototype._getTabWrapper = function(tabSize) {
    // Force this to be a number to prevent arbitrary injection.
    const result = this._createElement('span', 'tab');
    result.style['tab-size'] = tabSize;
    result.style['-moz-tab-size'] = tabSize;
    result.innerText = '\t';
    return result;
  };

  GrDiffBuilder.prototype._createElement = function(tagName, classStr) {
    const el = document.createElement(tagName);
    // When Shady DOM is being used, these classes are added to account for
    // Polymer's polyfill behavior. In order to guarantee sufficient
    // specificity within the CSS rules, these are added to every element.
    // Since the Polymer DOM utility functions (which would do this
    // automatically) are not being used for performance reasons, this is
    // done manually.
    el.classList.add('style-scope', 'gr-diff');
    if (classStr) {
      for (const className of classStr.split(' ')) {
        el.classList.add(className);
      }
    }
    return el;
  };

  GrDiffBuilder.prototype._handleLayerUpdate = function(start, end, side) {
    this._renderContentByRange(start, end, side);
  };

  /**
   * Finds the next DIV.contentText element following the given element, and on
   * the same side. Will only search within a group.
   * @param {HTMLElement} content
   * @param {string} side Either 'left' or 'right'
   * @return {HTMLElement}
   */
  GrDiffBuilder.prototype._getNextContentOnSide = function(content, side) {
    throw Error('Subclasses must implement _getNextContentOnSide');
  };

  /**
   * Determines whether the given group is either totally an addition or totally
   * a removal.
   * @param {!Object} group (GrDiffGroup)
   * @return {boolean}
   */
  GrDiffBuilder.prototype._isTotal = function(group) {
    return group.type === GrDiffGroup.Type.DELTA &&
        (!group.adds.length || !group.removes.length) &&
        !(!group.adds.length && !group.removes.length);
  };

  /**
   * Set the blame information for the diff. For any already-rendered line,
   * re-render its blame cell content.
   * @param {Object} blame
   */
  GrDiffBuilder.prototype.setBlame = function(blame) {
    this._blameInfo = blame;

    // TODO(wyatta): make this loop asynchronous.
    for (const commit of blame) {
      for (const range of commit.ranges) {
        for (let i = range.start; i <= range.end; i++) {
          // TODO(wyatta): this query is expensive, but, when traversing a
          // range, the lines are consecutive, and given the previous blame
          // cell, the next one can be reached cheaply.
          const el = this._getBlameByLineNum(i);
          if (!el) { continue; }
          // Remove the element's children (if any).
          while (el.hasChildNodes()) {
            el.removeChild(el.lastChild);
          }
          const blame = this._getBlameForBaseLine(i, commit);
          el.appendChild(blame);
        }
      }
    }
  };

  /**
   * Find the blame cell for a given line number.
   * @param {number} lineNum
   * @return {HTMLTableDataCellElement}
   */
  GrDiffBuilder.prototype._getBlameByLineNum = function(lineNum) {
    const root = Polymer.dom(this._outputEl);
    return root.querySelector(`td.blame[data-line-number="${lineNum}"]`);
  };

  /**
   * Given a base line number, return the commit containing that line in the
   * current set of blame information. If no blame information has been
   * provided, null is returned.
   * @param {number} lineNum
   * @return {Object} The commit information.
   */
  GrDiffBuilder.prototype._getBlameCommitForBaseLine = function(lineNum) {
    if (!this._blameInfo) { return null; }

    for (const blameCommit of this._blameInfo) {
      for (const range of blameCommit.ranges) {
        if (range.start <= lineNum && range.end >= lineNum) {
          return blameCommit;
        }
      }
    }
    return null;
  };

  /**
   * Given the number of a base line, get the content for the blame cell of that
   * line. If there is no blame information for that line, returns null.
   * @param {number} lineNum
   * @param {Object=} opt_commit Optionally provide the commit object, so that
   *     it does not need to be searched.
   * @return {HTMLSpanElement}
   */
  GrDiffBuilder.prototype._getBlameForBaseLine = function(lineNum, opt_commit) {
    const commit = opt_commit || this._getBlameCommitForBaseLine(lineNum);
    if (!commit) { return null; }

    const isStartOfRange = commit.ranges.some(r => r.start === lineNum);

    const date = (new Date(commit.time * 1000)).toLocaleDateString();
    const blameNode = this._createElement('span',
        isStartOfRange ? 'startOfRange' : '');
    const shaNode = this._createElement('span', 'sha');
    shaNode.innerText = commit.id.substr(0, 7);
    blameNode.appendChild(shaNode);
    blameNode.append(` on ${date} by ${commit.author}`);
    return blameNode;
  };

  /**
   * Create a blame cell for the given base line. Blame information will be
   * included in the cell if available.
   * @param {GrDiffLine} line
   * @return {HTMLTableDataCellElement}
   */
  GrDiffBuilder.prototype._createBlameCell = function(line) {
    const blameTd = this._createElement('td', 'blame');
    blameTd.setAttribute('data-line-number', line.beforeNumber);
    if (line.beforeNumber) {
      const content = this._getBlameForBaseLine(line.beforeNumber);
      if (content) {
        blameTd.appendChild(content);
      }
    }
    return blameTd;
  };

  window.GrDiffBuilder = GrDiffBuilder;
})(window, GrDiffGroup, GrDiffLine);
