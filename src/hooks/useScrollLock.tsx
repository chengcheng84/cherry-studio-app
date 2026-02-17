import type { ReactNode, RefObject } from 'react'
import React, { createContext, useCallback, useContext, useRef, useState } from 'react'

// 延迟解锁时间 (ms) - 给复制菜单稳定的时间
const UNLOCK_DELAY = 300

interface ScrollLockContextType {
  isLocked: boolean
  lock: () => void
  unlock: () => void
  lockScroll: (currentOffset: number) => void
  unlockScroll: () => void
  restoreScrollPosition: () => void
  savedScrollOffset: RefObject<number>
  scrollAttempts: RefObject<number>
}

const ScrollLockContext = createContext<ScrollLockContextType | undefined>(undefined)

export function ScrollLockProvider({ children }: { children: ReactNode }) {
  const [isLocked, setIsLocked] = useState(false)
  const savedScrollOffset = useRef(0)
  const scrollAttempts = useRef(0)
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lock = useCallback(() => {
    setIsLocked(true)
  }, [])

  const unlock = useCallback(() => {
    setIsLocked(false)
  }, [])

  // 带参数的锁定，保存当前滚动位置
  const lockScroll = useCallback((currentOffset: number) => {
    savedScrollOffset.current = currentOffset
    scrollAttempts.current = 0
    setIsLocked(true)
    console.log('[useScrollLock] lockScroll 调用，保存位置:', currentOffset)
  }, [savedScrollOffset, scrollAttempts])

  // 延迟解锁，给菜单稳定时间
  const unlockScroll = useCallback(() => {
    // 清除之前的定时器
    if (unlockTimerRef.current) {
      clearTimeout(unlockTimerRef.current)
    }

    unlockTimerRef.current = setTimeout(() => {
      setIsLocked(false)
      scrollAttempts.current = 0
      unlockTimerRef.current = null
    }, UNLOCK_DELAY)
  }, [scrollAttempts])

  // 在 Android 上恢复滚动位置的辅助函数
  const restoreScrollPosition = useCallback(() => {
    // 这个函数用于在需要时手动恢复滚动位置
    // 目前主要由 scrollEnabled={!isLocked} 来控制
  }, [])

  return (
    <ScrollLockContext.Provider
      value={{
        isLocked,
        lock,
        unlock,
        lockScroll,
        unlockScroll,
        restoreScrollPosition,
        savedScrollOffset,
        scrollAttempts
      }}>
      {children}
    </ScrollLockContext.Provider>
  )
}

export function useScrollLock() {
  const context = useContext(ScrollLockContext)
  if (!context) {
    return {
      isLocked: false,
      lock: () => {},
      unlock: () => {},
      lockScroll: () => {},
      unlockScroll: () => {},
      restoreScrollPosition: () => {},
      savedScrollOffset: { current: 0 },
      scrollAttempts: { current: 0 }
    }
  }
  return context
}
