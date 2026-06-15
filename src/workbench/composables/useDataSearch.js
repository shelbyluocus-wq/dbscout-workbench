import { ref } from "vue";

export function useDataSearch(invokeWorkbench, treeQuery, { statusText }) {
  const dataSearchResults = ref([]);
  const dataSearchLoading = ref(false);

  async function runDataSearch() {
    const query = treeQuery.value.trim();
    if (!query) {
      dataSearchResults.value = [];
      return;
    }
    dataSearchLoading.value = true;
    try {
      dataSearchResults.value = await invokeWorkbench("search_data", {
        request: { query },
      });
      statusText.value = `数据搜索命中 ${dataSearchResults.value.length} 张表`;
    } catch (error) {
      statusText.value = `数据搜索失败：${String(error)}`;
    } finally {
      dataSearchLoading.value = false;
    }
  }

  return {
    dataSearchResults,
    dataSearchLoading,
    runDataSearch,
  };
}
