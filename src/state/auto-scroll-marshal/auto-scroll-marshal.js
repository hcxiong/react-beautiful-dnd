// @flow
import rafSchd from 'raf-schd';
import getViewport from '../visibility/get-viewport';
import { add, isEqual } from '../position';
import { vertical, horizontal } from '../axis';
import getScrollableDroppableOver from './get-scrollable-droppable-over';
import {
  canScrollDroppable,
  canScrollWindow,
  getWindowOverlap,
  getDroppableOverlap,
} from './can-scroll';
import scrollWindow from './scroll-window';
import getWindowScrollPosition from '../../view/get-window-scroll-position';
import type { AutoScrollMarshal } from './auto-scroll-marshal-types';
import type {
  Area,
  Axis,
  DroppableId,
  DragState,
  DroppableDimension,
  Position,
  State,
  Spacing,
  DraggableLocation,
  DraggableDimension,
  ClosestScrollable,
  DraggableId,
} from '../../types';

type Args = {|
  scrollDroppable: (id: DroppableId, change: Position) => void,
  move: (id: DraggableId, client: Position, windowScroll: Position, shouldAnimate: boolean) => void,
|}

// Values used to control how the fluid auto scroll feels
const config = {
  // percentage distance from edge of container:
  startFrom: 0.25,
  maxSpeedAt: 0.05,
  // pixels per frame
  maxScrollSpeed: 28,
  // A function used to ease the distance been the startFrom and maxSpeedAt values
  // A simple linear function would be: (percentage) => percentage;
  // percentage is between 0 and 1
  // result must be between 0 and 1
  ease: (percentage: number) => Math.pow(percentage, 2),
};

const origin: Position = { x: 0, y: 0 };

type PixelThresholds = {|
  startFrom: number,
  maxSpeedAt: number,
  accelerationPlane: number,
|}

// converts the percentages in the config into actual pixel values
const getPixelThresholds = (container: Area, axis: Axis): PixelThresholds => {
  const startFrom: number = container[axis.size] * config.startFrom;
  const maxSpeedAt: number = container[axis.size] * config.maxSpeedAt;
  const accelerationPlane: number = startFrom - maxSpeedAt;

  const thresholds: PixelThresholds = {
    startFrom,
    maxSpeedAt,
    accelerationPlane,
  };

  return thresholds;
};

const getSpeed = (distance: number, thresholds: PixelThresholds): number => {
  // Not close enough to the edge
  if (distance >= thresholds.startFrom) {
    return 0;
  }

  // Already past the maxSpeedAt point

  if (distance <= thresholds.maxSpeedAt) {
    return config.maxScrollSpeed;
  }

  // We need to perform a scroll as a percentage of the max scroll speed

  const distancePastStart: number = thresholds.startFrom - distance;
  const percentage: number = distancePastStart / thresholds.accelerationPlane;
  const transformed: number = config.ease(percentage);

  const speed: number = config.maxScrollSpeed * transformed;

  return speed;
};

// returns null if no scroll is required
const getRequiredScroll = (container: Area, center: Position): ?Position => {
  // get distance to each edge
  const distance: Spacing = {
    top: center.y - container.top,
    right: container.right - center.x,
    bottom: container.bottom - center.y,
    left: center.x - container.left,
  };

  // 1. Figure out which x,y values are the best target
  // 2. Can the container scroll in that direction at all?
  // If no for both directions, then return null
  // 3. Is the center close enough to a edge to start a drag?
  // 4. Based on the distance, calculate the speed at which a scroll should occur
  // The lower distance value the faster the scroll should be.
  // Maximum speed value should be hit before the distance is 0
  // Negative values to not continue to increase the speed

  const y: number = (() => {
    const thresholds: PixelThresholds = getPixelThresholds(container, vertical);
    const isCloserToBottom: boolean = distance.bottom < distance.top;

    if (isCloserToBottom) {
      return getSpeed(distance.bottom, thresholds);
    }

    // closer to top
    return -1 * getSpeed(distance.top, thresholds);
  })();

  const x: number = (() => {
    const thresholds: PixelThresholds = getPixelThresholds(container, horizontal);
    const isCloserToRight: boolean = distance.right < distance.left;

    if (isCloserToRight) {
      return getSpeed(distance.right, thresholds);
    }

    // closer to left
    return -1 * getSpeed(distance.left, thresholds);
  })();

  const required: Position = { x, y };

  return isEqual(required, origin) ? null : required;
};

const isTooBigForAutoScrolling = (frame: Area, subject: Area): boolean =>
  subject.width > frame.width || subject.height > frame.height;

export default ({
  scrollDroppable,
  move,
}: Args): AutoScrollMarshal => {
  // TODO: do not scroll if drag has finished
  const scheduleWindowScroll = rafSchd(scrollWindow);
  const scheduleDroppableScroll = rafSchd(scrollDroppable);

  const fluidScroll = (state: State) => {
    const drag: ?DragState = state.drag;
    if (!drag) {
      console.error('Invalid drag state');
      return;
    }

    const center: Position = drag.current.page.center;

    // 1. Can we scroll the viewport?

    const draggable: DraggableDimension = state.dimension.draggable[drag.initial.descriptor.id];
    const viewport: Area = getViewport();

    if (isTooBigForAutoScrolling(viewport, draggable.page.withMargin)) {
      return;
    }

    const requiredWindowScroll: ?Position = getRequiredScroll(viewport, center);

    if (requiredWindowScroll && canScrollWindow(requiredWindowScroll)) {
      scheduleWindowScroll(requiredWindowScroll);
      return;
    }

    // 2. We are not scrolling the window. Can we scroll the Droppable?

    const droppable: ?DroppableDimension = getScrollableDroppableOver({
      target: center,
      droppables: state.dimension.droppable,
    });

    // No scrollable targets
    if (!droppable) {
      return;
    }

    // We know this has a closestScrollable
    const closestScrollable: ClosestScrollable = (droppable.viewport.closestScrollable : any);

    if (isTooBigForAutoScrolling(closestScrollable.frame, draggable.page.withMargin)) {
      return;
    }

    const requiredFrameScroll: ?Position = getRequiredScroll(closestScrollable.frame, center);

    if (requiredFrameScroll && canScrollDroppable(droppable, requiredFrameScroll)) {
      scheduleDroppableScroll(droppable.descriptor.id, requiredFrameScroll);
    }
  };

  const performMove = (state: State, offset: Position) => {
    const drag: ?DragState = state.drag;
    if (!drag) {
      return;
    }

    const client: Position = add(drag.current.client.selection, offset);
    move(drag.initial.descriptor.id, client, getWindowScrollPosition(), true);
  };

  const jumpScroll = (state: State) => {
    const drag: ?DragState = state.drag;

    if (!drag) {
      return;
    }

    const request: ?Position = drag.scrollJumpRequest;

    if (!request) {
      return;
    }

    const draggable: DraggableDimension = state.dimension.draggable[drag.initial.descriptor.id];
    const destination: ?DraggableLocation = drag.impact.destination;

    if (!destination) {
      console.error('Cannot perform a jump scroll when there is no destination');
      return;
    }

    const droppable: DroppableDimension = state.dimension.droppable[destination.droppableId];
    const closestScrollable: ?ClosestScrollable = droppable.viewport.closestScrollable;

    if (closestScrollable) {
      if (isTooBigForAutoScrolling(closestScrollable.frame, draggable.page.withMargin)) {
        performMove(state, request);
        return;
      }

      if (canScrollDroppable(droppable, request)) {
        // not scheduling - jump requests need to be performed instantly

        // if the window can also not be scrolled - adjust the item
        if (!canScrollWindow(request)) {
          const overlap: ?Position = getDroppableOverlap(droppable, request);

          if (overlap) {
            console.warn('DROPPABLE OVERLAP', overlap);
            performMove(state, overlap);
          }
        }

        scrollDroppable(droppable.descriptor.id, request);
        return;
      }

      // can now check if we need to scroll the window
    }

    // Scroll the window if we can

    if (isTooBigForAutoScrolling(getViewport(), draggable.page.withMargin)) {
      performMove(state, request);
      return;
    }

    if (!canScrollWindow(request)) {
      console.warn('Jump scroll requested but it cannot be done by Droppable or the Window');
      performMove(state, request);
      return;
    }

    const overlap: ?Position = getWindowOverlap(request);

    if (overlap) {
      console.warn('WINDOW OVERLAP', overlap);
      performMove(state, overlap);
    }

    // not scheduling - jump requests need to be performed instantly
    scrollWindow(request);
  };

  const onStateChange = (previous: State, current: State): void => {
    // now dragging
    if (current.phase === 'DRAGGING') {
      if (!current.drag) {
        console.error('invalid drag state');
        return;
      }

      if (current.drag.initial.autoScrollMode === 'FLUID') {
        fluidScroll(current);
        return;
      }

      // autoScrollMode == 'JUMP'

      if (!current.drag.scrollJumpRequest) {
        return;
      }

      jumpScroll(current);
    }

    // cancel any pending scrolls if no longer dragging
    if (previous.phase === 'DRAGGING' && current.phase !== 'DRAGGING') {
      scheduleWindowScroll.cancel();
      scheduleDroppableScroll.cancel();
    }
  };

  const marshal: AutoScrollMarshal = {
    onStateChange,
  };

  return marshal;
};

