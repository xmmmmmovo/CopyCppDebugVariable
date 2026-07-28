#include <array>
#include <memory>
#include <string>
#include <utility>
#include <vector>

struct Address {
    std::string city;
    std::string street;
    int number{};
};

struct Person {
    std::string name;
    int age{};
    Address address;
    std::array<int, 4> scores{};
    std::vector<std::string> tags;
};

struct Company {
    std::string name;
    std::vector<Person> employees;
    Person* director{};
};

struct LinkedNode {
    int value{};
    std::string label;
    std::unique_ptr<LinkedNode> next;
};

int main() {
    Person alice{
        .name = "Alice",
        .age = 29,
        .address = {"Shenzhen", "Debug Road", 23},
        .scores = {98, 87, 95, 100},
        .tags = {"cpp23", "debug", "vscode"},
    };
    Person bob{
        .name = "Bob",
        .age = 34,
        .address = {"Shanghai", "Variable Street", 8},
        .scores = {76, 88, 91, 84},
        .tags = {"cmake", "clang", "testing"},
    };

    std::vector<Person> people{alice, bob};
    Company company{
        .name = "Variable Labs",
        .employees = people,
        .director = &people[0],
    };

    auto linked = std::make_unique<LinkedNode>(LinkedNode{
        .value = 1,
        .label = "first",
        .next = std::make_unique<LinkedNode>(LinkedNode{
            .value = 2,
            .label = "second",
            .next = std::make_unique<LinkedNode>(LinkedNode{.value = 3, .label = "third"}),
        }),
    });

    const auto totalScore = alice.scores[0] + alice.scores[1] + alice.scores[2] + alice.scores[3];
    (void)totalScore;

    // Set a breakpoint here and inspect the variables recursively.
    return people.size() + static_cast<int>(company.employees.size()) + linked->value;
}
