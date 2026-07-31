#include <array>
#include <cstddef>
#include <memory>
#include <memory_resource>
#include <string>
#include <string_view>
#include <vector>

// ---- Custom tracking allocator ---------------------------------------------
// Every allocate/deallocate bumps a static counter so the debugger view can
// show how many backing-store allocations the string has triggered.
template <typename T>
struct TrackingAllocator {
    using value_type = T;

    TrackingAllocator() noexcept = default;
    template <typename U>
    constexpr TrackingAllocator(const TrackingAllocator<U>&) noexcept {}

    T* allocate(std::size_t n) {
        ++alloc_count;
        return static_cast<T*>(::operator new(n * sizeof(T)));
    }

    void deallocate(T* p, std::size_t) noexcept {
        ++dealloc_count;
        ::operator delete(p);
    }

    inline static int alloc_count   = 0;
    inline static int dealloc_count = 0;
};

using TrackingString = std::basic_string<char, std::char_traits<char>, TrackingAllocator<char>>;

// ---- Existing demo types (string values diversified) -----------------------

struct Address {
    std::string city;     // medium ("Shenzhen", "Shanghai")
    std::string street;   // short ("Debug Road", "Long Avenue Name Spanning More")
    int number{};
};

struct Person {
    std::string name;                            // short
    int age{};
    Address address;
    std::array<int, 4> scores{};
    std::vector<std::string> tags;               // short tags
};

struct Company {
    std::string name;                            // medium
    std::vector<Person> employees;
    Person* director{};
};

struct LinkedNode {
    int value{};
    std::string label;                           // short
    std::unique_ptr<LinkedNode> next;
};

// ---- New showcase: many flavours of string -------------------------------

struct StringShowcase {
    // --- size variants: empty / SSO / just-over-SSO / heap / very long ----
    std::string empty;                                            // size 0
    std::string tiny = "Hi";                                      // SSO  (2 chars)
    std::string short_sso = "0123456789abc";                      // SSO  (13 chars)
    std::string boundary_sso = "0123456789abcdef";                // SSO  (15 chars, libstdc++ cap)
    std::string just_over_sso =                                  // heap (just over SSO)
        "This string is just a bit too long to fit in SSO storage.";
    std::string medium =
        "The quick brown fox jumps over the lazy dog. "
        "Sphinx of black quartz, judge my vow.";                  // heap (~100)
    std::string long_str =
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit, "
        "sed do eiusmod tempor incididunt ut labore et dolore magna "
        "aliqua. Ut enim ad minim veniam, quis nostrud exercitation "
        "ullamco laboris nisi ut aliquip ex ea commodo consequat."; // heap (~300)
    std::string very_long;                                        // heap, large buffer

    // --- content variants ------------------------------------------------
    std::string  with_escapes = "line1\nline2\ttab\r\n\"quoted\"\\back";
    std::string  with_null    = std::string("abc\0def\0ghi", 11); // size=11, first \0 terminates C-strings
    std::u8string utf8        = u8"你好，世界！🌍 Привет мир! こんにちは";
    std::string   repeated;                                      // filled in ctor

    // --- character-type variants ----------------------------------------
    std::wstring  wide  = L"Hello, wide world! こんにちは / Привет";
    std::u16string u16s = u"UTF-16 string: 𝄞 musical symbol";
    std::u32string u32s = U"UTF-32 string: 𝄞 🎵 Δ";

    // --- non-owning view -------------------------------------------------
    std::string  backing_for_view = "View points into this buffer, not a copy.";
    std::string_view view{backing_for_view};

    // --- PMR string using a monotonic buffer (no heap allocations) ------
    alignas(std::pmr::monotonic_buffer_resource) std::byte pmr_buf[2048];
    std::pmr::monotonic_buffer_resource pmr_pool{pmr_buf, sizeof(pmr_buf)};
    std::pmr::string pmr_str{&pmr_pool};
    std::pmr::string pmr_long{&pmr_pool};

    // --- string with custom (tracking) allocator -----------------------
    TrackingString custom_alloc = "Custom-allocator string (SSO region).";
    TrackingString custom_alloc_long =
        "A longer custom-allocator string that must heap-allocate via the tracking allocator.";

    StringShowcase() {
        very_long.assign(4096, 'x');
        very_long.replace(0, 11, "head-AAAAA");
        very_long.replace(very_long.size() - 8, 8, "-ZZZtail");

        for (int i = 0; i < 8; ++i) repeated += "abc";

        pmr_str  = std::pmr::string{
            "PMR string served from a monotonic buffer", &pmr_pool};
        pmr_long = std::pmr::string{
            "Another PMR string that should also fit in the 2 KiB monotonic buffer "
            "above, demonstrating that no heap allocation is performed.", &pmr_pool};
    }
};

int main() {
    Person alice{
        .name    = "Alice",
        .age     = 29,
        .address = {"Shenzhen", "Debug Road", 23},
        .scores  = {98, 87, 95, 100},
        .tags    = {"cpp23", "debug", "vscode", "short"},
    };
    Person bob{
        .name    = "Bob",
        .age     = 34,
        .address = {"Shanghai",
                    "A Very Long Avenue Name That Spans Quite A Few Characters In Total",
                    8},
        .scores  = {76, 88, 91, 84},
        .tags    = {"cmake", "clang", "testing", "medium-length-tag-value"},
    };
    Person carol{
        .name    = "Carol-With-A-Somewhat-Longer-Name",
        .age     = 41,
        .address = {"Hangzhou",
                    "Avenue Of Heap-Allocated Strings Demonstrating Long Buffer Behaviour",
                    1024},
        .scores  = {60, 70, 80, 90},
        .tags    = {"performance", "allocation-tracking", "ssotunnel"},
    };

    std::vector<Person> people{alice, bob, carol};
    Company company{
        .name      = "Variable Labs — Long Company Name Ltd.",
        .employees = people,
        .director  = &people[2],
    };

    auto linked = std::make_unique<LinkedNode>(LinkedNode{
        .value = 1,
        .label = "first",
        .next  = std::make_unique<LinkedNode>(LinkedNode{
            .value = 2,
            .label = "second-middling",
            .next  = std::make_unique<LinkedNode>(LinkedNode{
                .value = 3,
                .label = "third-with-a-rather-long-label-to-trigger-heap",
                .next  = nullptr,
            }),
        }),
    });

    StringShowcase strings;

    const auto totalScore = alice.scores[0] + alice.scores[1]
                          + alice.scores[2] + alice.scores[3];
    (void)totalScore;

    // Set a breakpoint here and inspect the variables recursively.
    return static_cast<int>(people.size())
         + static_cast<int>(company.employees.size())
         + linked->value
         + static_cast<int>(TrackingAllocator<char>::alloc_count);
}
