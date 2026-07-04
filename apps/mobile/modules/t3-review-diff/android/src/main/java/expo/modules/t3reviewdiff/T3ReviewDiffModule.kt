// Ported from upstream PR pingdotgg/t3code#3579 (branch android-dev-pr-3514) by
// @juliusmarminge. Mirrors the iOS T3ReviewDiffModule view contract (props,
// events, async commands) so `requireNativeView("T3ReviewDiffSurface")` resolves
// on Android. Keep in sync with ios/T3ReviewDiffModule.swift; reconcile against
// PR #3579. DEVIATION: adds the `refreshing` prop + `onPullToRefresh` event that
// PR #3579's Android port omitted, restoring parity with the iOS pull-to-refresh
// contract (see T3ReviewDiffView.setRefreshing).
package expo.modules.t3reviewdiff

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3ReviewDiffModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3ReviewDiffSurface")

    View(T3ReviewDiffView::class) {
      Prop("tokensResetKey") { view: T3ReviewDiffView, tokensResetKey: String ->
        view.setTokensResetKey(tokensResetKey)
      }
      Prop("contentResetKey") { view: T3ReviewDiffView, contentResetKey: String ->
        view.setContentResetKey(contentResetKey)
      }
      Prop("collapsedFileIdsJson") { view: T3ReviewDiffView, collapsedFileIdsJson: String ->
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }
      Prop("viewedFileIdsJson") { view: T3ReviewDiffView, viewedFileIdsJson: String ->
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }
      Prop("selectedRowIdsJson") { view: T3ReviewDiffView, selectedRowIdsJson: String ->
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }
      Prop("collapsedCommentIdsJson") { view: T3ReviewDiffView, collapsedCommentIdsJson: String ->
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }
      Prop("appearanceScheme") { view: T3ReviewDiffView, appearanceScheme: String ->
        view.setAppearanceScheme(appearanceScheme)
      }
      Prop("themeJson") { view: T3ReviewDiffView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("styleJson") { view: T3ReviewDiffView, styleJson: String ->
        view.setStyleJson(styleJson)
      }
      Prop("rowHeight") { view: T3ReviewDiffView, rowHeight: Double ->
        view.setRowHeight(rowHeight.toFloat())
      }
      Prop("contentWidth") { view: T3ReviewDiffView, contentWidth: Double ->
        view.setContentWidth(contentWidth.toFloat())
      }
      Prop("initialRowIndex") { view: T3ReviewDiffView, initialRowIndex: Double ->
        view.setInitialRowIndex(initialRowIndex)
      }
      // DEVIATION FROM PR #3579: pull-to-refresh prop, mirrors ios setRefreshing.
      Prop("refreshing") { view: T3ReviewDiffView, refreshing: Boolean ->
        view.setRefreshing(refreshing)
      }

      Events(
        "onDebug",
        "onVisibleFileChange",
        "onToggleFile",
        "onToggleViewedFile",
        "onPressLine",
        "onToggleComment",
        // DEVIATION FROM PR #3579: mirrors ios onPullToRefresh event.
        "onPullToRefresh",
      )

      AsyncFunction("scrollToFile") { view: T3ReviewDiffView, fileId: String, animated: Boolean ->
        view.scrollToFile(fileId, animated)
      }
      AsyncFunction("scrollToTop") { view: T3ReviewDiffView, animated: Boolean ->
        view.scrollToTop(animated)
      }
      AsyncFunction("setRowsJson") { view: T3ReviewDiffView, rowsJson: String ->
        view.setRowsJson(rowsJson)
      }
      AsyncFunction("setTokensJson") { view: T3ReviewDiffView, tokensJson: String ->
        view.setTokensJson(tokensJson)
      }
      AsyncFunction("setTokensPatchJson") { view: T3ReviewDiffView, tokensPatchJson: String ->
        view.setTokensPatchJson(tokensPatchJson)
      }

      OnViewDestroys { view: T3ReviewDiffView ->
        view.cleanup()
      }
    }
  }
}
