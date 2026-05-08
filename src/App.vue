<script setup lang="ts">
import { ref } from 'vue'
import WasmPlayer from './components/WasmPlayer.vue'

const videoUrl = ref<string>('')

const localVideos = [
  {
    name: 'audio',
    url: '/videos/audio.mp3',
    format: 'MPEG Audio',
    size: '2.9M'
  },
  {
    name: 'demo-720p-h264',
    url: '/videos/demo-720p-h264.mp4',
    format: 'H.264 MP4',
    size: '7.6M'
  },
  {
    name: 'demo-720p-h265',
    url: '/videos/demo-720p-h265.mp4',
    format: 'H.265/HEVC MP4',
    size: '6.7M'
  },
  // {
  //   name: 'demo-720p',
  //   url: '/videos/demo-720p.flv',
  //   format: 'FLV',
  //   size: '65.0M'
  // }
]

const loadLocalVideo = (url: string) => {
  videoUrl.value = url
}
</script>

<template>
  <div class="app">
    <h1>H.265 视频播放器</h1>
    <p class="description">支持 H.265/HEVC 和其他常见视频格式</p>

    <div class="test-videos">
      <h3>🎬 本地测试视频</h3>
      <p class="section-desc">这些视频已下载到项目中，无需网络连接</p>
      <div class="video-list">
        <button
          v-for="video in localVideos"
          :key="video.url"
          class="video-item"
          @click="loadLocalVideo(video.url)"
        >
          <div class="video-info">
            <span class="video-name">{{ video.name }}</span>
            <span class="video-format">{{ video.format }}</span>
          </div>
          <span class="video-size">{{ video.size }}</span>
        </button>
      </div>
    </div>

    <WasmPlayer
      v-if="videoUrl"
      :src="videoUrl"
      :autoplay="true"
    />
  </div>
</template>

<style scoped>
.app {
  width: 100%;
  max-width: 1200px;
}

h1 {
  font-size: 2.5rem;
  margin-bottom: 0.5rem;
  color: #2c3e50;
}

.description {
  color: #7f8c8d;
  margin-bottom: 2rem;
}

h3 {
  font-size: 1.2rem;
  margin-bottom: 1rem;
  color: #2c3e50;
}

.test-videos {
  margin: 2rem 0;
  padding: 1.5rem;
  background: #e8f5e9;
  border-radius: 8px;
  border: 2px solid #4caf50;
}

.section-desc {
  color: #2e7d32;
  font-size: 0.9rem;
  margin-bottom: 1rem;
}

.video-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
}

.video-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  background: white;
  border: 2px solid #4caf50;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.3s;
  text-align: left;
}

.video-item:hover {
  border-color: #2e7d32;
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(76, 175, 80, 0.2);
}

.video-info {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.video-name {
  font-weight: 600;
  color: #2c3e50;
}

.video-format {
  font-size: 0.85rem;
  color: #7f8c8d;
}

.video-size {
  font-size: 0.85rem;
  color: #4caf50;
  font-weight: 600;
}

@media (max-width: 768px) {
  .video-list {
    grid-template-columns: 1fr;
  }
}
</style>
