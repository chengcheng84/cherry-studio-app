import type { ReactNode } from 'react'
import React, { useCallback, useRef } from 'react'
import type { TextProps } from 'react-native'
import { Platform, View } from 'react-native'
import { UITextView } from 'react-native-uitextview'
import { withUniwind } from 'uniwind'

import { useScrollLock } from '@/hooks/useScrollLock'

const StyledUITextView = withUniwind(UITextView)

interface SelectableTextProps extends TextProps {
  children: ReactNode
}

// 长按判定阈值 (ms)
const LONG_PRESS_THRESHOLD = 300

export function SelectableText({ children, ...props }: SelectableTextProps) {
  const { lockScroll, unlockScroll, savedScrollOffset } = useScrollLock()
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isLongPressRef = useRef(false)
  const hasLockedRef = useRef(false)

  const handlePressIn = useCallback(() => {
    if (Platform.OS !== 'android') return

    // 清除之前的定时器
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
    }

    isLongPressRef.current = false
    hasLockedRef.current = false

    // 定时器判定长按
    longPressTimerRef.current = setTimeout(() => {
      isLongPressRef.current = true
      // 使用 lockScroll，传入当前滚动位置
      lockScroll(savedScrollOffset.current)
      hasLockedRef.current = true
    }, LONG_PRESS_THRESHOLD)
  }, [lockScroll, savedScrollOffset])

  const handlePressOut = useCallback(() => {
    // 清除长按定时器
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    // 如果是长按后的抬起，使用延迟解锁
    if (isLongPressRef.current) {
      isLongPressRef.current = false
      unlockScroll()
      return
    }

    // 如果不是长按，也使用延迟解锁（给菜单稳定时间）
    unlockScroll()
  }, [unlockScroll])

  // 对于 iOS，使用 onLongPress
  const handleLongPress = useCallback(() => {
    if (Platform.OS === 'ios') {
      lockScroll(savedScrollOffset.current)
      hasLockedRef.current = true
    }
  }, [lockScroll, savedScrollOffset])

  const handleIOSPressOut = useCallback(() => {
    unlockScroll()
  }, [unlockScroll])

  return (
    <View collapsable={false}>
      <StyledUITextView
        selectable
        uiTextView
        pointerEvents="box-none"
        onPressIn={handlePressIn}
        onPressOut={Platform.OS === 'android' ? handlePressOut : handleIOSPressOut}
        onLongPress={handleLongPress}
        {...props}>
        {children}
      </StyledUITextView>
    </View>
  )
}
