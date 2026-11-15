#!/usr/bin/env bash
# 由目标工作树 install.sh 按顺序 source；共享其严格模式、日志函数与安装上下文。

# 判断给定目录本身是否为独立 Git 仓库根（两侧均解析物理路径，落在外层仓库子目录内时返回非零）。
is_git_repository_root() {
  local target="" toplevel=""
  target="$(cd -- "$1" 2>/dev/null && pwd -P)" || return 1
  toplevel="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ "$toplevel" = "$target" ]
}

# 工作树没有 git 仓库时就地初始化 `.git`、拉取远端 tag 并按内容匹配当前 HEAD。
# 只更新 `.git` 与索引，不改写工作树文件，也不把未跟踪部署数据写入对象库；失败时降级继续安装。
ensure_git_repository() {
  is_git_repository_root "$PWD" && return 0

  warn "这棵工作树没有 git 仓库（多半是解压发布包得到的），照现状此后没法用 git 更新。"
  if ! command -v git >/dev/null 2>&1; then
    info "缺少 git，尝试用系统包管理器安装……"
    if ! install_system_packages git || ! command -v git >/dev/null 2>&1; then
      warn "装不上 git，跳过建立仓库。此后更新只能手工替换文件。"
      return 0
    fi
  fi

  info "就地建立 git 仓库（只动 .git 与索引，不改任何已有文件）……"
  if ! git init --quiet; then
    warn "git init 失败（多半是对 ${PWD} 没有写权限），跳过建立仓库。"
    return 0
  fi
  if ! git remote get-url origin >/dev/null 2>&1 && ! git remote add origin "$REPOSITORY_URL"; then
    warn "设置 origin 失败，跳过建立仓库。"
    return 0
  fi

  info "拉取 ${REPOSITORY_URL} 的 tag（首次要下整段历史，会慢一会儿）……"
  if ! git fetch --tags --quiet origin; then
    warn "拉不到 tag（网络或限流）。仓库与 origin 已就绪，联网后自行 git fetch --tags。"
    return 0
  fi

  # 逐个已发布 tag 用 read-tree + diff-index 比对受跟踪文件内容：
  # 仅读取 tag 树对象并对比受跟踪文件，忽略 config/、memory/、database/ 等未跟踪部署数据。
  local candidate="" matched="" head_commit=""
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    git read-tree "${candidate}^{tree}" 2>/dev/null || continue
    # read-tree 后先刷新索引 stat 缓存，再由 diff-index 比对工作树内容。
    git update-index -q --refresh >/dev/null 2>&1 || true
    if git diff-index --quiet "${candidate}^{tree}" --; then
      matched="$candidate"
      break
    fi
  done < <(git tag --list)

  # 退出循环时索引仍保留最后一个候选 tag 的树：未匹配时清空索引，匹配时将 HEAD 与索引对齐到该 tag。
  if [ -z "$matched" ]; then
    git read-tree --empty >/dev/null 2>&1 || true
    warn "工作树与任何已发布 tag 都对不上（改过，或不是发布包）。"
    warn "仓库与 origin/tags 已就绪，但 HEAD 未指向任何版本；核对后自行 git checkout <tag>。"
    return 0
  fi

  # 将 HEAD 以 detached 状态指向匹配的 tag commit 并同步索引，全程不改写工作树文件。
  head_commit="$(git rev-parse --verify "${matched}^{commit}" 2>/dev/null)" || head_commit=""
  if [ -z "$head_commit" ] ||
    ! git update-ref --no-deref HEAD "$head_commit" ||
    ! git reset --mixed --quiet; then
    git read-tree --empty >/dev/null 2>&1 || true
    warn "把 HEAD 指到 ${matched} 失败。仓库与 origin/tags 已就绪，自行 git checkout ${matched} 即可。"
    return 0
  fi
  info "git 仓库已就绪，HEAD 指向 ${matched}，与现有文件逐字一致；此后 git fetch --tags 再 checkout 新 tag 即可更新。"
}
