import { memo, useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

const skeletonRowHeight = 36;
const skeletonBarHeight = 14;
const skeletonBarInset = 20;

const skeletonRows = [
  { id: 's0', width: 0.6 },
  { id: 's1', width: 0.45 },
  { id: 's2', width: 0.72 },
  { id: 's3', width: 0.5 },
  { id: 's4', width: 0.65 },
  { id: 's5', width: 0.38 },
  { id: 's6', width: 0.55 },
  { id: 's7', width: 0.48 },
  { id: 's8', width: 0.68 },
  { id: 's9', width: 0.42 },
];

export const DrawerTopicListSkeleton = memo(function DrawerTopicListSkeleton() {
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(0.35, { duration: 850 }),
      -1,
      true,
      () => {},
      ReduceMotion.Never,
    );
  }, [pulse]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: pulse.value,
  }));

  return (
    <View className="pt-2">
      {skeletonRows.map((row) => (
        <View key={row.id} style={{ height: skeletonRowHeight, justifyContent: 'center' }}>
          <Animated.View
            className="rounded-lg bg-surface-secondary"
            style={[
              {
                height: skeletonBarHeight,
                marginHorizontal: skeletonBarInset,
                width: `${Math.round(row.width * 100)}%`,
              },
              animatedStyle,
            ]}
          />
        </View>
      ))}
    </View>
  );
});
