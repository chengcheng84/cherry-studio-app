import type { LegendListRef } from '@legendapp/list'
import { LegendList } from '@legendapp/list'
import { BlurView } from 'expo-blur'
import { SymbolView } from 'expo-symbols'
import { MotiView } from 'moti'
import type { FC } from 'react'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import { Keyboard, Platform, StyleSheet, View } from 'react-native'
import Animated, { useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSelector } from 'react-redux'

import { YStack } from '@/componentsV2'
import { LiquidGlassButton } from '@/componentsV2/base/LiquidGlassButton'
import { GradientBlurEdge } from '@/componentsV2/features/ChatScreen/GradientBlurEdge'
import { ArrowDown } from '@/componentsV2/icons'
import { useInitialScrollToEnd } from '@/hooks/chat/useInitialScrollToEnd'
import { useTopicBlocks } from '@/hooks/useMessageBlocks'
import { useMessages } from '@/hooks/useMessages'
import { ScrollLockProvider, useScrollLock } from '@/hooks/useScrollLock'
import { useTheme } from '@/hooks/useTheme'
import type { RootState } from '@/store'
import type { Assistant, Topic } from '@/types/assistant'
import type { GroupedMessage } from '@/types/message'
import { isIOS } from '@/utils/device'
import { getGroupedMessages } from '@/utils/messageUtils/filters'

import WelcomeContent from '../WelcomeContent'
import MessageGroup from './MessageGroup'

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView)

interface MessagesProps {
  assistant: Assistant
  topic: Topic
}

const MessagesContent: FC<MessagesProps> = ({ assistant, topic }) => {
  const { messages } = useMessages(topic.id)
  const { messageBlocks } = useTopicBlocks(topic.id)
  const { isDark } = useTheme()
  const groupedMessages = Object.entries(getGroupedMessages(messages))
  const legendListRef = useRef<LegendListRef>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [isAtBottom, setIsAtBottom] = useState(false)
  const { isLocked, savedScrollOffset, scrollAttempts } = useScrollLock()

  // 用于检测真正的固定位置（调试用）
  const detectedFixedPosition = useRef<number | null>(null)
  const fixedPositionLogs = useRef<number[]>([])

  // 跟踪键盘状态，用于检测键盘收起导致的滚动
  const [keyboardVisible, setKeyboardVisible] = useState(false)

  useEffect(() => {
    const keyboardDidShowListener = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardVisible(true)
    })
    const keyboardDidHideListener = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false)
    })

    return () => {
      keyboardDidShowListener.remove()
      keyboardDidHideListener.remove()
    }
  }, [])

  // 控制 maintainScrollAtEnd 的状态
  const [maintainAtEnd, setMaintainAtEnd] = useState(true)

  // 监听锁定状态，临时禁用 maintainScrollAtEnd
  useEffect(() => {
    if (isLocked) {
      // 锁定时禁用
      setMaintainAtEnd(false)
    } else {
      // 解锁时延迟恢复，给菜单稳定时间
      const timer = setTimeout(() => {
        setMaintainAtEnd(true)
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [isLocked])

  // 关键：锁定后立即禁用 scrollEnabled，从根本上阻止滚动
  const scrollEnabled = !isLocked

  // 调试：输出检测到的固定位置
  useEffect(() => {
    if (detectedFixedPosition.current !== null) {
      console.log('[调试] 检测到的固定位置:', detectedFixedPosition.current)
      console.log('[调试] 固定位置记录:', fixedPositionLogs.current)
    }
  }, [isLocked])

  // 关键：使用 useLayoutEffect 在布局绘制前立即恢复滚动位置（防止闪动）
  useLayoutEffect(() => {
    if (isLocked && legendListRef.current && savedScrollOffset.current > 0) {
      console.log('[useLayoutEffect] 锁定触发，立即恢复滚动位置到:', savedScrollOffset.current)
      // 立即恢复，不使用动画
      legendListRef.current?.scrollToOffset({
        offset: savedScrollOffset.current,
        animated: false
      })
    }
  }, [isLocked])

  // 持续监听滚动，长按期间任何偏移都立即恢复（防止长按期间持续滚动）
  const lastRestoredOffset = useRef<number>(0)

  // Editing state
  const editingMessage = useSelector((state: RootState) => state.runtime.editingMessage)
  const isEditing = !!editingMessage

  // Blur animation
  const blurIntensity = useSharedValue(0)

  useEffect(() => {
    blurIntensity.value = withTiming(isEditing ? 10 : 0, { duration: 200 })
  }, [isEditing, blurIntensity])

  const blurAnimatedProps = useAnimatedProps(() => ({
    intensity: blurIntensity.value
  }))

  // Initial scroll to end logic
  const listLayoutReady = useSharedValue(0)
  const hasMessages = groupedMessages.length > 0

  const scrollToEnd = useCallback(
    ({ animated }: { animated: boolean }) => {
      if (legendListRef.current && groupedMessages.length > 0) {
        legendListRef.current.scrollToOffset({
          offset: 9999999,
          animated
        })
      }
    },
    [groupedMessages.length]
  )

  useInitialScrollToEnd(listLayoutReady, scrollToEnd, hasMessages)

  // Trigger scroll when messages are loaded (not on layout)
  useEffect(() => {
    if (hasMessages && listLayoutReady.get() === 0) {
      // Delay to ensure list has rendered
      requestAnimationFrame(() => {
        listLayoutReady.set(1)
      })
    }
  }, [hasMessages, listLayoutReady])

  const renderMessageGroup = ({ item }: { item: [string, GroupedMessage[]] }) => {
    return (
      <MotiView
        from={{
          opacity: 0,
          translateY: 10
        }}
        animate={{
          opacity: 1,
          translateY: 0
        }}
        transition={{
          type: 'timing',
          duration: 300,
          delay: 100
        }}>
        <MessageGroup assistant={assistant} item={item} messageBlocks={messageBlocks} />
      </MotiView>
    )
  }

  const scrollToBottom = useCallback(() => {
    if (legendListRef.current && groupedMessages.length > 0) {
      legendListRef.current.scrollToOffset({ offset: 9999999, animated: true })
    }
  }, [groupedMessages.length])

  const handleScrollToEnd = () => {
    scrollToBottom()
  }

  // 处理布局变化 - 在布局阶段就阻止滚动（比 onScroll 更早）
  const handleLayout = useCallback(() => {
    if (isLocked && legendListRef.current && savedScrollOffset.current > 0) {
      console.log('[调试] onLayout: 检测到布局变化，立即恢复滚动位置到:', savedScrollOffset.current)
      // 使用 requestAnimationFrame 确保在下一帧渲染前恢复
      requestAnimationFrame(() => {
        legendListRef.current?.scrollToOffset({
          offset: savedScrollOffset.current,
          animated: false
        })
      })
    }
  }, [isLocked])

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const threshold = 100
    const edgeThreshold = 10
    const currentY = contentOffset.y

    // 检测是否在底部
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - currentY
    setIsAtBottom(distanceFromBottom <= edgeThreshold)
    setShowScrollButton(distanceFromBottom > threshold)

    // 未锁定时持续保存滚动位置
    if (!isLocked) {
      savedScrollOffset.current = currentY
      lastRestoredOffset.current = currentY
    }

    // 键盘收起时检测滚动，如果是键盘收起导致的，立即恢复
    if (!keyboardVisible && savedScrollOffset.current > 0) {
      const scrollDiff = Math.abs(currentY - savedScrollOffset.current)
      // 键盘收起导致的滚动通常较大，恢复位置
      if (scrollDiff > 100 && scrollDiff < 500) {
        console.log('[handleScroll] 检测到键盘收起导致的滚动，恢复:', currentY, '→', savedScrollOffset.current)
        legendListRef.current?.scrollToOffset({
          offset: savedScrollOffset.current,
          animated: false
        })
        return
      }
    }

    // 锁定时检测滚动行为
    if (isLocked) {
      // 记录每次锁定时的滚动位置
      console.log(`[调试] 锁定时滚动 - 时间：${Date.now()}, 位置：${currentY}, 保存位置：${savedScrollOffset.current}`)

      // 检测是否发生了不需要的滚动（与上次恢复位置相比）
      const offsetFromLastRestored = Math.abs(currentY - lastRestoredOffset.current)

      // 如果偏离了恢复位置超过阈值，立即恢复
      if (offsetFromLastRestored > 50 && savedScrollOffset.current > 0) {
        console.log('[handleScroll] 检测到偏移，立即恢复:', currentY, '→', savedScrollOffset.current)

        // 立即恢复，不使用动画
        legendListRef.current?.scrollToOffset({
          offset: savedScrollOffset.current,
          animated: false
        })

        // 更新最后恢复位置，避免重复触发
        lastRestoredOffset.current = savedScrollOffset.current
      }

      // 动态检测偏移量：maintainScrollAtEnd 导致的偏移通常在 400-700px 之间
      const offset = savedScrollOffset.current - currentY

      // 如果偏移量在合理范围内（是 maintainScrollAtEnd 导致的）
      if (offset > 300 && offset < 800) {
        // 记录这个"固定偏移"
        if (!detectedFixedPosition.current) {
          detectedFixedPosition.current = currentY
          fixedPositionLogs.current = [currentY]
          console.log('[调试] 首次检测到固定位置:', currentY, '偏移量:', offset)
        } else {
          fixedPositionLogs.current.push(currentY)
          console.log('[调试] 再次检测到固定位置:', currentY, '偏移量:', offset, '历史记录:', fixedPositionLogs.current)
        }
      }
    }
  }

  return (
    <View className="flex-1" collapsable={false}>
      <LegendList
        ref={legendListRef}
        showsVerticalScrollIndicator={false}
        data={groupedMessages}
        extraData={assistant}
        renderItem={renderMessageGroup}
        keyExtractor={([key, group]) => `${key}-${group[0]?.id}`}
        ItemSeparatorComponent={() => <YStack className="h-5" />}
        contentContainerStyle={{
          flexGrow: 1
        }}
        onScroll={handleScroll}
        onLayout={handleLayout}
        scrollEventThrottle={16}
        recycleItems
        maintainScrollAtEnd={maintainAtEnd}
        maintainScrollAtEndThreshold={0.01}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={<WelcomeContent />}
        scrollEnabled={!isLocked}
      />
      <GradientBlurEdge visible={!isAtBottom && groupedMessages.length > 0} />
      <AnimatedBlurView
        animatedProps={blurAnimatedProps}
        experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : 'none'}
        tint={isDark ? 'dark' : 'light'}
        style={[styles.blurOverlay, { pointerEvents: isEditing ? 'auto' : 'none' }]}
      />
      {showScrollButton && (
        <MotiView
          key="scroll-to-bottom-button"
          style={styles.fab}
          from={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ type: 'timing' }}>
          <LiquidGlassButton size={35} onPress={handleScrollToEnd}>
            {isIOS ? (
              <SymbolView name="arrow.down" size={20} tintColor={isDark ? 'white' : 'black'} />
            ) : (
              <ArrowDown size={24} />
            )}
          </LiquidGlassButton>
        </MotiView>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 8,
    alignItems: 'center'
  },
  blurOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0
  }
})

const Messages: FC<MessagesProps> = props => {
  return (
    <ScrollLockProvider>
      <MessagesContent {...props} />
    </ScrollLockProvider>
  )
}

export default Messages
