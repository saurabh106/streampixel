#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>

typedef int VkResult;
typedef void* VkPhysicalDevice;

typedef struct VkPhysicalDeviceLimits {
    char dummy[512];
} VkPhysicalDeviceLimits;

typedef struct VkPhysicalDeviceSparseProperties {
    uint32_t dummy[5];
} VkPhysicalDeviceSparseProperties;

typedef struct VkPhysicalDeviceProperties {
    uint32_t apiVersion;
    uint32_t driverVersion;
    uint32_t vendorID;
    uint32_t deviceID;
    uint32_t deviceType; // VkPhysicalDeviceType: 4 = CPU, 1 = INTEGRATED_GPU
    char deviceName[256];
    uint8_t pipelineCacheUUID[16];
    VkPhysicalDeviceLimits limits;
    VkPhysicalDeviceSparseProperties sparseProperties;
} VkPhysicalDeviceProperties;

typedef struct VkPhysicalDeviceProperties2 {
    uint32_t sType;
    void* pNext;
    VkPhysicalDeviceProperties properties;
} VkPhysicalDeviceProperties2;

typedef struct VkPhysicalDeviceFeatures {
    uint32_t robustBufferAccess;
    uint32_t fullDrawIndexUint32;
    uint32_t imageCubeArray;
    uint32_t independentBlend;
    uint32_t geometryShader;
    uint32_t tessellationShader;
    uint32_t sampleRateShading;
    uint32_t dualSrcBlend;
    uint32_t logicOp;
    uint32_t multiDrawIndirect;
    uint32_t drawIndirectFirstInstance;
    uint32_t depthClamp;
    uint32_t depthBiasClamp;
    uint32_t fillModeNonSolid;
    uint32_t depthBounds;
    uint32_t wideLines;
    uint32_t largePoints;
    uint32_t alphaToOne;
    uint32_t multiViewport;
    uint32_t samplerAnisotropy;
    uint32_t textureCompressionETC2;
    uint32_t textureCompressionASTC_LDR;
    uint32_t textureCompressionBC;
    uint32_t occludedQueryPrecise;
    uint32_t pipelineStatisticsQuery;
    uint32_t vertexPipelineStoresAndAtomics;
    uint32_t fragmentStoresAndAtomics;
    uint32_t shaderTessellationAndGeometryPointSize;
    uint32_t shaderImageGatherExtended;
    uint32_t shaderStorageImageExtendedFormats;
    uint32_t shaderStorageImageMultisample;
    uint32_t shaderStorageImageReadWithoutFormat;
    uint32_t shaderStorageImageWriteWithoutFormat;
    uint32_t shaderUniformBufferArrayDynamicIndexing;
    uint32_t shaderSampledImageArrayDynamicIndexing;
    uint32_t shaderStorageBufferArrayDynamicIndexing;
    uint32_t shaderStorageImageArrayDynamicIndexing;
    uint32_t shaderClipDistance;
    uint32_t shaderCullDistance;
    uint32_t shaderFloat64;
    uint32_t shaderInt64;
    uint32_t shaderInt16;
    uint32_t shaderResourceResidency;
    uint32_t shaderResourceMinLOD;
    uint32_t sparseBinding;
    uint32_t sparseResidencyBuffer;
    uint32_t sparseResidencyImage2D;
    uint32_t sparseResidencyImage3D;
    uint32_t sparseResidency2Samples;
    uint32_t sparseResidency4Samples;
    uint32_t sparseResidency8Samples;
    uint32_t sparseResidency16Samples;
    uint32_t sparseResidencyAliased;
    uint32_t variableMultisampleRate;
    uint32_t inheritedQueries;
} VkPhysicalDeviceFeatures;

typedef struct VkPhysicalDeviceFeatures2 {
    uint32_t sType;
    void* pNext;
    VkPhysicalDeviceFeatures features;
} VkPhysicalDeviceFeatures2;

typedef void (*fn_vkGetPhysicalDeviceProperties)(VkPhysicalDevice, VkPhysicalDeviceProperties*);
typedef void (*fn_vkGetPhysicalDeviceProperties2)(VkPhysicalDevice, VkPhysicalDeviceProperties2*);
typedef void (*fn_vkGetPhysicalDeviceFeatures)(VkPhysicalDevice, VkPhysicalDeviceFeatures*);
typedef void (*fn_vkGetPhysicalDeviceFeatures2)(VkPhysicalDevice, VkPhysicalDeviceFeatures2*);

static fn_vkGetPhysicalDeviceProperties real_props1 = NULL;
static fn_vkGetPhysicalDeviceProperties2 real_props2 = NULL;
static fn_vkGetPhysicalDeviceFeatures real_feats1 = NULL;
static fn_vkGetPhysicalDeviceFeatures2 real_feats2 = NULL;

void vkGetPhysicalDeviceProperties(VkPhysicalDevice pd, VkPhysicalDeviceProperties* pProperties) {
    if (!real_props1) real_props1 = (fn_vkGetPhysicalDeviceProperties)dlsym(RTLD_NEXT, "vkGetPhysicalDeviceProperties");
    if (real_props1) real_props1(pd, pProperties);
    if (pProperties && pProperties->deviceType == 4) { // VK_PHYSICAL_DEVICE_TYPE_CPU -> INTEGRATED_GPU
        pProperties->deviceType = 1;
    }
}

void vkGetPhysicalDeviceProperties2(VkPhysicalDevice pd, VkPhysicalDeviceProperties2* pProperties) {
    if (!real_props2) real_props2 = (fn_vkGetPhysicalDeviceProperties2)dlsym(RTLD_NEXT, "vkGetPhysicalDeviceProperties2");
    if (!real_props2) real_props2 = (fn_vkGetPhysicalDeviceProperties2)dlsym(RTLD_NEXT, "vkGetPhysicalDeviceProperties2KHR");
    if (real_props2) real_props2(pd, pProperties);
    if (pProperties && pProperties->properties.deviceType == 4) {
        pProperties->properties.deviceType = 1;
    }
}

void vkGetPhysicalDeviceProperties2KHR(VkPhysicalDevice pd, VkPhysicalDeviceProperties2* pProperties) {
    vkGetPhysicalDeviceProperties2(pd, pProperties);
}

void vkGetPhysicalDeviceFeatures(VkPhysicalDevice pd, VkPhysicalDeviceFeatures* pFeatures) {
    if (!real_feats1) real_feats1 = (fn_vkGetPhysicalDeviceFeatures)dlsym(RTLD_NEXT, "vkGetPhysicalDeviceFeatures");
    if (real_feats1) real_feats1(pd, pFeatures);
    if (pFeatures) {
        pFeatures->geometryShader = 1;
        pFeatures->tessellationShader = 1;
        pFeatures->shaderInt64 = 1;
        pFeatures->shaderInt16 = 1;
        pFeatures->samplerAnisotropy = 1;
    }
}

void vkGetPhysicalDeviceFeatures2(VkPhysicalDevice pd, VkPhysicalDeviceFeatures2* pFeatures) {
    if (!real_feats2) real_feats2 = (fn_vkGetPhysicalDeviceFeatures2)dlsym(RTLD_NEXT, "vkGetPhysicalDeviceFeatures2");
    if (!real_feats2) real_feats2 = (fn_vkGetPhysicalDeviceFeatures2)dlsym(RTLD_NEXT, "vkGetPhysicalDeviceFeatures2KHR");
    if (real_feats2) real_feats2(pd, pFeatures);
    if (pFeatures) {
        pFeatures->features.geometryShader = 1;
        pFeatures->features.tessellationShader = 1;
        pFeatures->features.shaderInt64 = 1;
        pFeatures->features.shaderInt16 = 1;
        pFeatures->features.samplerAnisotropy = 1;
    }
}

void vkGetPhysicalDeviceFeatures2KHR(VkPhysicalDevice pd, VkPhysicalDeviceFeatures2* pFeatures) {
    vkGetPhysicalDeviceFeatures2(pd, pFeatures);
}
