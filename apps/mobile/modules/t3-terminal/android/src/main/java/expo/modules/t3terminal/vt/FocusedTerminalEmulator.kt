package expo.modules.t3terminal.vt

import android.graphics.Color
import kotlin.math.max
import kotlin.math.min

internal data class TerminalCell(
  var codePoint: Int = 32,
  var foreground: Int? = null,
  var background: Int? = null,
  var bold: Boolean = false,
  var inverse: Boolean = false,
) {
  fun copyFrom(other: TerminalCell) {
    codePoint = other.codePoint
    foreground = other.foreground
    background = other.background
    bold = other.bold
    inverse = other.inverse
  }
}

internal data class TerminalSnapshot(
  val cols: Int,
  val rows: Int,
  val cells: List<List<TerminalCell>>,
  val cursorRow: Int,
  val cursorCol: Int,
  val showCursor: Boolean,
)

internal class FocusedTerminalEmulator(
  initialCols: Int = 80,
  initialRows: Int = 24,
  private val scrollbackLimit: Int = 1_000,
) {
  private enum class ParserState { Ground, Escape, Csi, Osc, OscEscape }

  private var parserState = ParserState.Ground
  private var csiBuffer = StringBuilder()
  private var oscBuffer = StringBuilder()
  private var currentStyle = TerminalCell()
  private var savedRow = 0
  private var savedCol = 0
  private var scrollTop = 0
  private var scrollBottom = max(initialRows - 1, 0)
  private val scrollback = ArrayDeque<Array<TerminalCell>>()
  private var pendingWrap = false

  var cols: Int = max(initialCols, 1)
    private set
  var rows: Int = max(initialRows, 1)
    private set
  var cursorRow: Int = 0
    private set
  var cursorCol: Int = 0
    private set
  var showCursor: Boolean = true
    private set
  var bracketedPasteMode: Boolean = false
    private set
  var title: String = ""
    private set

  private var screen: Array<Array<TerminalCell>> = newScreen(cols, rows)

  fun reset() {
    parserState = ParserState.Ground
    csiBuffer = StringBuilder()
    oscBuffer = StringBuilder()
    currentStyle = TerminalCell()
    savedRow = 0
    savedCol = 0
    scrollTop = 0
    scrollBottom = rows - 1
    cursorRow = 0
    cursorCol = 0
    pendingWrap = false
    showCursor = true
    bracketedPasteMode = false
    title = ""
    scrollback.clear()
    screen = newScreen(cols, rows)
  }

  fun resize(newCols: Int, newRows: Int) {
    val boundedCols = max(newCols, 1)
    val boundedRows = max(newRows, 1)
    if (boundedCols == cols && boundedRows == rows) return

    val resized = newScreen(boundedCols, boundedRows)
    val copyRows = min(rows, boundedRows)
    val copyCols = min(cols, boundedCols)
    for (row in 0 until copyRows) {
      for (col in 0 until copyCols) {
        resized[row][col].copyFrom(screen[row][col])
      }
    }

    cols = boundedCols
    rows = boundedRows
    screen = resized
    cursorRow = cursorRow.coerceIn(0, rows - 1)
    cursorCol = cursorCol.coerceIn(0, cols - 1)
    pendingWrap = false
    scrollTop = 0
    scrollBottom = rows - 1
  }

  fun feed(text: String) {
    var index = 0
    while (index < text.length) {
      val codePoint = text.codePointAt(index)
      index += Character.charCount(codePoint)
      feedCodePoint(codePoint)
    }
  }

  fun snapshot(): TerminalSnapshot = TerminalSnapshot(
    cols = cols,
    rows = rows,
    cells = screen.map { row -> row.map { it.copy() } },
    cursorRow = cursorRow,
    cursorCol = cursorCol,
    showCursor = showCursor,
  )

  private fun feedCodePoint(codePoint: Int) {
    when (parserState) {
      ParserState.Ground -> handleGround(codePoint)
      ParserState.Escape -> handleEscape(codePoint)
      ParserState.Csi -> handleCsi(codePoint)
      ParserState.Osc -> handleOsc(codePoint)
      ParserState.OscEscape -> handleOscEscape(codePoint)
    }
  }

  private fun handleGround(codePoint: Int) {
    when (codePoint) {
      0x1B -> parserState = ParserState.Escape
      0x07 -> Unit
      0x08 -> {
        pendingWrap = false
        cursorCol = max(cursorCol - 1, 0)
      }
      0x09 -> {
        pendingWrap = false
        cursorCol = min(((cursorCol / 8) + 1) * 8, cols - 1)
      }
      0x0A, 0x0B, 0x0C -> {
        pendingWrap = false
        lineFeed()
      }
      0x0D -> {
        pendingWrap = false
        cursorCol = 0
      }
      else -> if (codePoint >= 0x20) putCodePoint(codePoint)
    }
  }

  private fun handleEscape(codePoint: Int) {
    when (codePoint) {
      '['.code -> {
        csiBuffer = StringBuilder()
        parserState = ParserState.Csi
      }
      ']'.code -> {
        oscBuffer = StringBuilder()
        parserState = ParserState.Osc
      }
      '7'.code -> saveCursor()
      '8'.code -> restoreCursor()
      'D'.code -> lineFeed()
      'E'.code -> {
        cursorCol = 0
        lineFeed()
      }
      'M'.code -> reverseIndex()
      'c'.code -> reset()
      '('.code, ')'.code, '*'.code, '+'.code, '-'.code, '.'.code, '/'.code -> Unit
      else -> Unit
    }
    if (parserState == ParserState.Escape) parserState = ParserState.Ground
  }

  private fun handleCsi(codePoint: Int) {
    if (codePoint in 0x40..0x7E) {
      dispatchCsi(codePoint.toChar(), csiBuffer.toString())
      parserState = ParserState.Ground
    } else {
      csiBuffer.appendCodePoint(codePoint)
    }
  }

  private fun handleOsc(codePoint: Int) {
    when (codePoint) {
      0x07 -> {
        dispatchOsc(oscBuffer.toString())
        parserState = ParserState.Ground
      }
      0x1B -> parserState = ParserState.OscEscape
      else -> oscBuffer.appendCodePoint(codePoint)
    }
  }

  private fun handleOscEscape(codePoint: Int) {
    if (codePoint == '\\'.code) {
      dispatchOsc(oscBuffer.toString())
      parserState = ParserState.Ground
    } else {
      oscBuffer.appendCodePoint(0x1B)
      oscBuffer.appendCodePoint(codePoint)
      parserState = ParserState.Osc
    }
  }

  private fun dispatchCsi(final: Char, raw: String) {
    pendingWrap = false
    val privateMode = raw.startsWith('?')
    val cleaned = raw.dropWhile { it == '?' || it == '>' || it == '!' || it == ' ' }
    val params = parseParams(cleaned)

    when (final) {
      'A' -> cursorRow = max(cursorRow - params.defaultAt(0, 1), 0)
      'B' -> cursorRow = min(cursorRow + params.defaultAt(0, 1), rows - 1)
      'C' -> cursorCol = min(cursorCol + params.defaultAt(0, 1), cols - 1)
      'D' -> cursorCol = max(cursorCol - params.defaultAt(0, 1), 0)
      'E' -> {
        cursorRow = min(cursorRow + params.defaultAt(0, 1), rows - 1)
        cursorCol = 0
      }
      'F' -> {
        cursorRow = max(cursorRow - params.defaultAt(0, 1), 0)
        cursorCol = 0
      }
      'G', '`' -> cursorCol = params.defaultAt(0, 1).coerceIn(1, cols) - 1
      'H', 'f' -> {
        cursorRow = params.defaultAt(0, 1).coerceIn(1, rows) - 1
        cursorCol = params.defaultAt(1, 1).coerceIn(1, cols) - 1
      }
      'J' -> eraseDisplay(params.defaultAt(0, 0))
      'K' -> eraseLine(params.defaultAt(0, 0))
      'L' -> repeat(params.defaultAt(0, 1).coerceAtLeast(1)) { insertLine() }
      'M' -> repeat(params.defaultAt(0, 1).coerceAtLeast(1)) { deleteLine() }
      'P' -> deleteChars(params.defaultAt(0, 1).coerceAtLeast(1))
      '@' -> insertChars(params.defaultAt(0, 1).coerceAtLeast(1))
      'S' -> repeat(params.defaultAt(0, 1).coerceAtLeast(1)) { scrollUp() }
      'T' -> repeat(params.defaultAt(0, 1).coerceAtLeast(1)) { scrollDown() }
      'm' -> applySgr(params)
      'r' -> setScrollRegion(params)
      's' -> saveCursor()
      'u' -> restoreCursor()
      'h' -> setMode(params, privateMode, true)
      'l' -> setMode(params, privateMode, false)
    }
  }

  private fun dispatchOsc(raw: String) {
    val separator = raw.indexOf(';')
    if (separator <= 0) return
    when (raw.substring(0, separator).toIntOrNull()) {
      0, 2 -> title = raw.substring(separator + 1)
    }
  }

  private fun parseParams(raw: String): List<Int?> {
    if (raw.isEmpty()) return emptyList()
    return raw.split(';', ':').map { it.toIntOrNull() }
  }

  private fun List<Int?>.defaultAt(index: Int, defaultValue: Int): Int =
    getOrNull(index)?.takeIf { it != 0 } ?: defaultValue

  private fun setMode(params: List<Int?>, privateMode: Boolean, enabled: Boolean) {
    if (!privateMode) return
    params.filterNotNull().forEach { mode ->
      when (mode) {
        25 -> showCursor = enabled
        1049 -> {
          if (enabled) saveCursor() else restoreCursor()
          eraseDisplay(2)
        }
        2004 -> bracketedPasteMode = enabled
      }
    }
  }

  private fun applySgr(params: List<Int?>) {
    val values = if (params.isEmpty()) listOf(0) else params
    var index = 0
    while (index < values.size) {
      when (val value = values[index] ?: 0) {
        0 -> currentStyle = TerminalCell()
        1 -> currentStyle.bold = true
        22 -> currentStyle.bold = false
        7 -> currentStyle.inverse = true
        27 -> currentStyle.inverse = false
        39 -> currentStyle.foreground = null
        49 -> currentStyle.background = null
        in 30..37 -> currentStyle.foreground = ansiColor(value - 30, false)
        in 90..97 -> currentStyle.foreground = ansiColor(value - 90, true)
        in 40..47 -> currentStyle.background = ansiColor(value - 40, false)
        in 100..107 -> currentStyle.background = ansiColor(value - 100, true)
        38, 48 -> {
          val colorResult = parseExtendedColor(values, index + 1)
          if (colorResult != null) {
            if (value == 38) currentStyle.foreground = colorResult.first else currentStyle.background = colorResult.first
            index = colorResult.second
          }
        }
      }
      index += 1
    }
  }

  private fun parseExtendedColor(values: List<Int?>, start: Int): Pair<Int, Int>? {
    return when (values.getOrNull(start)) {
      5 -> values.getOrNull(start + 1)?.let { colorIndex -> xtermColor(colorIndex) to start + 1 }
      2 -> {
        val red = values.getOrNull(start + 1) ?: return null
        val green = values.getOrNull(start + 2) ?: return null
        val blue = values.getOrNull(start + 3) ?: return null
        Color.rgb(red.coerceIn(0, 255), green.coerceIn(0, 255), blue.coerceIn(0, 255)) to start + 3
      }
      else -> null
    }
  }

  private fun ansiColor(index: Int, bright: Boolean): Int {
    val normal = intArrayOf(
      Color.rgb(0, 0, 0),
      Color.rgb(205, 49, 49),
      Color.rgb(13, 188, 121),
      Color.rgb(229, 229, 16),
      Color.rgb(36, 114, 200),
      Color.rgb(188, 63, 188),
      Color.rgb(17, 168, 205),
      Color.rgb(229, 229, 229),
    )
    val brightValues = intArrayOf(
      Color.rgb(102, 102, 102),
      Color.rgb(241, 76, 76),
      Color.rgb(35, 209, 139),
      Color.rgb(245, 245, 67),
      Color.rgb(59, 142, 234),
      Color.rgb(214, 112, 214),
      Color.rgb(41, 184, 219),
      Color.rgb(255, 255, 255),
    )
    return (if (bright) brightValues else normal)[index.coerceIn(0, 7)]
  }

  private fun xtermColor(index: Int): Int {
    val bounded = index.coerceIn(0, 255)
    if (bounded < 16) return ansiColor(bounded % 8, bounded >= 8)
    if (bounded >= 232) {
      val level = 8 + (bounded - 232) * 10
      return Color.rgb(level, level, level)
    }
    val cube = bounded - 16
    val red = cube / 36
    val green = (cube / 6) % 6
    val blue = cube % 6
    fun channel(value: Int): Int = if (value == 0) 0 else 55 + value * 40
    return Color.rgb(channel(red), channel(green), channel(blue))
  }

  private fun putCodePoint(codePoint: Int) {
    if (pendingWrap) {
      cursorCol = 0
      lineFeed()
      pendingWrap = false
    }
    screen[cursorRow][cursorCol].copyFrom(currentStyle)
    screen[cursorRow][cursorCol].codePoint = codePoint
    if (cursorCol == cols - 1) {
      pendingWrap = true
    } else {
      cursorCol += 1
    }
  }

  private fun lineFeed() {
    if (cursorRow == scrollBottom) {
      scrollUp()
    } else {
      cursorRow = min(cursorRow + 1, rows - 1)
    }
  }

  private fun reverseIndex() {
    if (cursorRow == scrollTop) {
      scrollDown()
    } else {
      cursorRow = max(cursorRow - 1, 0)
    }
  }

  private fun scrollUp() {
    if (scrollTop == 0 && scrollback.size >= scrollbackLimit) scrollback.removeFirst()
    if (scrollTop == 0) scrollback.addLast(screen[scrollTop].map { it.copy() }.toTypedArray())
    for (row in scrollTop until scrollBottom) {
      screen[row] = screen[row + 1]
    }
    screen[scrollBottom] = blankRow(cols)
  }

  private fun scrollDown() {
    for (row in scrollBottom downTo (scrollTop + 1)) {
      screen[row] = screen[row - 1]
    }
    screen[scrollTop] = blankRow(cols)
  }

  private fun insertLine() {
    if (cursorRow !in scrollTop..scrollBottom) return
    for (row in scrollBottom downTo (cursorRow + 1)) {
      screen[row] = screen[row - 1]
    }
    screen[cursorRow] = blankRow(cols)
  }

  private fun deleteLine() {
    if (cursorRow !in scrollTop..scrollBottom) return
    for (row in cursorRow until scrollBottom) {
      screen[row] = screen[row + 1]
    }
    screen[scrollBottom] = blankRow(cols)
  }

  private fun insertChars(count: Int) {
    val bounded = count.coerceAtMost(cols - cursorCol)
    for (col in (cols - 1) downTo (cursorCol + bounded)) {
      screen[cursorRow][col].copyFrom(screen[cursorRow][col - bounded])
    }
    for (col in cursorCol until cursorCol + bounded) {
      screen[cursorRow][col] = TerminalCell()
    }
  }

  private fun deleteChars(count: Int) {
    val bounded = count.coerceAtMost(cols - cursorCol)
    for (col in cursorCol until cols - bounded) {
      screen[cursorRow][col].copyFrom(screen[cursorRow][col + bounded])
    }
    for (col in cols - bounded until cols) {
      screen[cursorRow][col] = TerminalCell()
    }
  }

  private fun eraseDisplay(mode: Int) {
    when (mode) {
      0 -> {
        eraseLine(0)
        for (row in cursorRow + 1 until rows) clearRow(row)
      }
      1 -> {
        for (row in 0 until cursorRow) clearRow(row)
        eraseLine(1)
      }
      2, 3 -> {
        for (row in 0 until rows) clearRow(row)
        if (mode == 3) scrollback.clear()
      }
    }
  }

  private fun eraseLine(mode: Int) {
    when (mode) {
      0 -> for (col in cursorCol until cols) screen[cursorRow][col] = TerminalCell()
      1 -> for (col in 0..cursorCol) screen[cursorRow][col] = TerminalCell()
      2 -> clearRow(cursorRow)
    }
  }

  private fun setScrollRegion(params: List<Int?>) {
    val top = params.defaultAt(0, 1).coerceIn(1, rows) - 1
    val bottom = params.defaultAt(1, rows).coerceIn(top + 1, rows) - 1
    scrollTop = top
    scrollBottom = bottom
    cursorRow = 0
    cursorCol = 0
  }

  private fun saveCursor() {
    savedRow = cursorRow
    savedCol = cursorCol
  }

  private fun restoreCursor() {
    cursorRow = savedRow.coerceIn(0, rows - 1)
    cursorCol = savedCol.coerceIn(0, cols - 1)
  }

  private fun clearRow(row: Int) {
    screen[row] = blankRow(cols)
  }

  private fun newScreen(cols: Int, rows: Int): Array<Array<TerminalCell>> =
    Array(rows) { blankRow(cols) }

  private fun blankRow(cols: Int): Array<TerminalCell> = Array(cols) { TerminalCell() }
}
